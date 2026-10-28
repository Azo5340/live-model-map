#!/usr/bin/env python3
"""
bridge.py — pont entre l'analyseur de modèles et le dashboard "Live Model Map".

Pour chaque fichier modèle (GGUF ou safetensors), le script lance
    <analyseur> inspect-model-artifact <fichier> --detail complete --json
lit le rapport Evidence produit (normalized_result.metadata), le
convertit au schéma attendu par le backend, puis l'envoie à
    l'endpoint d'ingestion du backend (DEFAULT_ENDPOINT).

L'analyseur fait une analyse *statique* : il lit les en-têtes sans charger le modèle.
Il fournit donc l'identité, le fournisseur, le modèle parent et la fenêtre de
contexte, mais pas les métriques d'exécution (tokens/s, latence, coût, ELO,
téléchargements). Celles-ci valent 0 par défaut et peuvent être fournies via
--enrich (fichier JSON).

Exemples :
    python3 bridge.py ~/models/                      # scanne un dossier
    python3 bridge.py model.gguf --dry-run           # affiche sans envoyer
    python3 bridge.py ~/models --watch 60            # rescanne toutes les 60 s
    python3 bridge.py --report rapport.json          # rapport déjà sauvegardé  
    python3 bridge.py ~/models --enrich metrics.json

Format de --enrich (clé = id du modèle, ou "*" pour tous) :
    {"*": {"usage_stats": {"active_requests_est": 1}},
     "meta-llama/llama-3.1-8b-instruct": {"metrics": {"tokens_per_sec": 42.5}}}

Dépendances : Python 3.9+ (bibliothèque standard uniquement) et Node.js
pour l'analyseur. Si sa commande n'est pas installée, le script passe
par npx (voir ANALYZER_BIN et ANALYZER_NPX_PACKAGE).
"""

from __future__ import annotations

import argparse
import copy
import json
import logging
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

# Valeurs imposées par l'outil et par le backend : ne pas renommer.
DEFAULT_ENDPOINT = "http://localhost:8000/api/ingest/rea-event"
ANALYZER_BIN = "rea"
ANALYZER_NPX_PACKAGE = "rea-agents@latest"
MODEL_EXTENSIONS = {".gguf", ".safetensors"}
# Fichiers safetensors fragmentés : model-00001-of-00004.safetensors
SHARD_RE = re.compile(r"^(?P<stem>.+)-(?P<idx>\d{5})-of-(?P<total>\d{5})$")
HF_URL_RE = re.compile(r"huggingface\.co/(?:models/)?([^/\s]+/[^/\s?#]+)")

log = logging.getLogger("bridge")


# --------------------------------------------------------------------------
# Lancement de l'analyseur
# --------------------------------------------------------------------------

def analyzer_env() -> dict[str, str]:
    """Environnement de l'analyseur, avec ~/.local/node/bin ajouté au PATH s'il existe."""
    env = os.environ.copy()
    local_node = Path.home() / ".local" / "node" / "bin"
    if local_node.is_dir():
        env["PATH"] = f"{local_node}{os.pathsep}{env.get('PATH', '')}"
    return env


def resolve_analyzer_cmd(explicit: str | None) -> list[str]:
    """Commande : --analyzer-cmd, puis $ANALYZER_CMD, puis ANALYZER_BIN, puis npx."""
    cmd = explicit or os.environ.get("ANALYZER_CMD")
    if cmd:
        return shlex.split(cmd)
    path = analyzer_env()["PATH"]
    if shutil.which(ANALYZER_BIN, path=path):
        return [ANALYZER_BIN]
    if shutil.which("npx", path=path):
        return ["npx", "-y", ANALYZER_NPX_PACKAGE]
    raise SystemExit(
        f"analyseur introuvable : installez Node.js puis `npm install --global {ANALYZER_NPX_PACKAGE}`, "
        "ou indiquez la commande avec --analyzer-cmd."
    )


def parse_json_output(text: str) -> Any:
    """Parse la sortie de l'analyseur, en ignorant d'éventuelles lignes avant le JSON."""
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        if start < 0:
            raise
        return json.loads(text[start:])


def run_analyzer(analyzer_cmd: list[str], target: Path, timeout: float) -> dict[str, Any]:
    cmd = [*analyzer_cmd, "inspect-model-artifact", str(target), "--detail", "complete", "--json"]
    log.debug("exec: %s", shlex.join(cmd))
    # On lance depuis le dossier personnel plutôt que depuis le dossier du
    # modèle, comme recommandé pour npx.
    proc = subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout,
        env=analyzer_env(), cwd=Path.home(),
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip()[-2000:]
        raise RuntimeError(f"l'analyseur a échoué (code {proc.returncode}) : {detail}")
    return parse_json_output(proc.stdout)


# --------------------------------------------------------------------------
# Lecture du rapport
# --------------------------------------------------------------------------

def find_model_artifacts(node: Any) -> Iterable[dict[str, Any]]:
    """Trouve les objets ModelArtifact ({artifact, format, metadata, ...}).

    Le CLI renvoie un objet Evidence dont `normalized_result` est le rapport,
    mais on parcourt tout l'arbre pour accepter aussi les enveloppes
    ({ok, result}), les bundles ({records: [...]}) et les listes.
    """
    if isinstance(node, dict):
        if isinstance(node.get("metadata"), list) and isinstance(node.get("artifact"), dict):
            yield node
            return
        for value in node.values():
            yield from find_model_artifacts(value)
    elif isinstance(node, list):
        for item in node:
            yield from find_model_artifacts(item)


def metadata_map(artifact: dict[str, Any]) -> dict[str, Any]:
    """Transforme metadata [{key, type, value, ...}] en {key: value}."""
    return {m["key"]: m.get("value") for m in artifact.get("metadata", []) if "key" in m}


def as_int(value: Any) -> int | None:
    """L'analyseur écrit les entiers 64 bits en chaînes décimales : on accepte les deux."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value)
    return None


def as_str(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9._-]+", "-", text.lower()).strip("-.")
    return s or "unknown"


def hf_repo_id(url: Any) -> str | None:
    """https://huggingface.co/org/model -> org/model"""
    if not isinstance(url, str):
        return None
    m = HF_URL_RE.search(url)
    return m.group(1).removesuffix(".git") if m else None


def to_iso8601(value: Any) -> str | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return datetime.fromtimestamp(value, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    text = as_str(value)
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def read_sidecars(model_path: Path) -> dict[str, Any]:
    """Infos d'un dossier Hugging Face voisin du modèle (config.json, README.md)."""
    info: dict[str, Any] = {}
    folder = model_path.parent
    config = folder / "config.json"
    if config.is_file():
        try:
            cfg = json.loads(config.read_text(encoding="utf-8"))
            info["name_or_path"] = as_str(cfg.get("_name_or_path"))
            info["context_window"] = as_int(
                cfg.get("max_position_embeddings")
                or cfg.get("n_positions")
                or cfg.get("max_sequence_length")
            )
        except (OSError, ValueError):
            pass
    readme = folder / "README.md"
    if readme.is_file():
        try:
            head = readme.read_text(encoding="utf-8", errors="replace")[:8000]
            m = re.search(r"^base_model:\s*\n?\s*(?:-\s*)?([\w.-]+/[\w.-]+)", head, re.M)
            if m:
                info["base_model"] = m.group(1)
        except OSError:
            pass
    return info


def build_event(artifact: dict[str, Any]) -> dict[str, Any]:
    """Construit l'évènement attendu par l'endpoint d'ingestion."""
    md = metadata_map(artifact)
    path = Path(artifact["artifact"]["path"])
    sidecar = read_sidecars(path)

    # Nom : general.name > basename + size_label > config.json > nom du fichier
    stem = SHARD_RE.sub(r"\g<stem>", path.stem)
    if stem in {"model", "consolidated", "pytorch_model"}:
        stem = path.parent.name
    basename = as_str(md.get("general.basename"))
    size_label = as_str(md.get("general.size_label"))
    name = (
        as_str(md.get("general.name"))
        or (f"{basename} {size_label}" if basename and size_label else basename)
        or (sidecar.get("name_or_path") or "").split("/")[-1]
        or stem
    )

    repo = hf_repo_id(md.get("general.repo_url")) or hf_repo_id(md.get("general.url"))
    if not repo and (sidecar.get("name_or_path") or "").count("/") == 1:
        repo = sidecar["name_or_path"]

    provider = (
        as_str(md.get("general.organization"))
        or as_str(md.get("general.author"))
        or (repo.split("/")[0] if repo else None)
        or "Unknown"
    )
    model_id = repo.lower() if repo else f"{slug(provider)}/{slug(name)}"

    # Modèle parent : general.base_model.0.* (GGUF) ou base_model du README
    parent = None
    if (as_int(md.get("general.base_model.count")) or 0) > 0:
        parent = hf_repo_id(md.get("general.base_model.0.repo_url"))
        if not parent:
            b_org = as_str(md.get("general.base_model.0.organization"))
            b_name = as_str(md.get("general.base_model.0.name"))
            if b_name:
                parent = f"{slug(b_org or provider)}/{slug(b_name)}"
    parent = parent or sidecar.get("base_model")
    if parent:
        parent = parent.lower()
        if parent == model_id:
            parent = None

    # Fenêtre de contexte : <architecture>.context_length en priorité
    arch = as_str(md.get("general.architecture"))
    context = as_int(md.get(f"{arch}.context_length")) if arch else None
    if context is None:
        context = next(
            (as_int(v) for k, v in md.items() if k.endswith(".context_length") and as_int(v)),
            None,
        )
    context = context or sidecar.get("context_window") or 0

    # Date : métadonnée si elle existe, sinon date de modification du fichier
    release = None
    for key in ("general.date", "general.release_date", "release_date", "created_at"):
        release = to_iso8601(md.get(key))
        if release:
            break
    if not release:
        try:
            release = to_iso8601(path.stat().st_mtime)
        except OSError:
            release = to_iso8601(time.time())

    return {
        "id": model_id,
        "name": name,
        "provider": provider,
        "parent_model_id": parent,
        "release_date": release,
        "metrics": {
            "tokens_per_sec": 0.0,
            "latency_ms": 0.0,
            "cost_per_1k_tokens": 0.0,
            "context_window": int(context),
            "elo_score": 0.0,
        },
        "usage_stats": {
            "download_count_24h": 0,
            "active_requests_est": 0,
        },
    }


# --------------------------------------------------------------------------
# Enrichissement et validation
# --------------------------------------------------------------------------

def deep_merge(base: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def apply_enrichment(event: dict[str, Any], enrich: dict[str, Any]) -> dict[str, Any]:
    if "*" in enrich:
        event = deep_merge(event, enrich["*"])
    if event["id"] in enrich:
        event = deep_merge(event, enrich[event["id"]])
    return normalize_types(event)


def normalize_types(event: dict[str, Any]) -> dict[str, Any]:
    """Force les types du schéma (float / int) pour éviter un 422 de FastAPI."""
    floats = ("tokens_per_sec", "latency_ms", "cost_per_1k_tokens", "elo_score")
    m = event["metrics"]
    for k in floats:
        m[k] = float(m.get(k) or 0.0)
    m["context_window"] = int(m.get("context_window") or 0)
    u = event["usage_stats"]
    for k in ("download_count_24h", "active_requests_est"):
        u[k] = int(u.get(k) or 0)
    return event


# --------------------------------------------------------------------------
# Envoi au backend
# --------------------------------------------------------------------------

def post_event(endpoint: str, event: dict[str, Any], retries: int = 3, timeout: float = 10.0) -> None:
    body = json.dumps(event).encode("utf-8")
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(
            endpoint, data=body, method="POST",
            headers={"Content-Type": "application/json", "User-Agent": "model-bridge/1.0"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                log.info("envoyé %s -> HTTP %s", event["id"], resp.status)
                return
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:500]
            if 400 <= e.code < 500:  # erreur de schéma : réessayer ne sert à rien
                raise RuntimeError(f"le backend a refusé {event['id']} (HTTP {e.code}) : {detail}") from e
            err: Exception = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            err = e
        if attempt < retries:
            delay = 2 ** attempt
            log.warning("échec d'envoi (%s), nouvel essai dans %ss", err, delay)
            time.sleep(delay)
    raise RuntimeError(f"impossible de joindre {endpoint} : {err}")


# --------------------------------------------------------------------------
# Découverte des cibles
# --------------------------------------------------------------------------

def collect_targets(paths: list[str]) -> list[Path]:
    """Fichiers modèles à inspecter ; un seul fragment par modèle fragmenté."""
    found: list[Path] = []
    for raw in paths:
        p = Path(raw).expanduser().resolve()
        if p.is_dir():
            found.extend(sorted(f for f in p.rglob("*") if f.is_file() and f.suffix.lower() in MODEL_EXTENSIONS))
        elif p.is_file():
            found.append(p)
        else:
            log.warning("introuvable : %s", p)
    seen_shards: set[tuple[Path, str]] = set()
    targets = []
    for f in found:
        m = SHARD_RE.match(f.stem)
        if m:
            key = (f.parent, m.group("stem"))
            if key in seen_shards:
                continue
            seen_shards.add(key)
        targets.append(f)
    return targets


def file_signature(p: Path) -> tuple[int, int]:
    st = p.stat()
    return (st.st_size, int(st.st_mtime))


# --------------------------------------------------------------------------
# Programme principal
# --------------------------------------------------------------------------

def emit(event: dict[str, Any], args: argparse.Namespace) -> bool:
    if args.dry_run:
        print(json.dumps(event, indent=2, ensure_ascii=False))
        return True
    try:
        post_event(args.endpoint, event)
        return True
    except RuntimeError as e:
        log.error("%s", e)
        return False


def process_report(report: Any, args: argparse.Namespace, enrich: dict[str, Any]) -> tuple[int, int]:
    ok = fail = 0
    for artifact in find_model_artifacts(report):
        event = apply_enrichment(build_event(artifact), enrich)
        if emit(event, args):
            ok += 1
        else:
            fail += 1
    return ok, fail


def scan_once(args, analyzer_cmd, enrich, seen: dict[Path, tuple[int, int]]) -> tuple[int, int]:
    ok = fail = 0
    for target in collect_targets(args.targets):
        try:
            sig = file_signature(target)
        except OSError:
            continue
        if seen.get(target) == sig:
            continue  # inchangé depuis le dernier passage (--watch)
        log.info("inspection : %s", target)
        try:
            report = run_analyzer(analyzer_cmd, target, args.timeout)
        except (RuntimeError, subprocess.TimeoutExpired, ValueError) as e:
            log.error("%s : %s", target.name, e)
            fail += 1
            continue
        o, f = process_report(report, args, enrich)
        if o == 0 and f == 0:
            log.error("%s : aucun rapport de modèle dans la sortie de l'analyseur", target.name)
            fail += 1
        ok, fail = ok + o, fail + f
        if f == 0 and o > 0:
            seen[target] = sig
    return ok, fail


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Pont analyseur de modèles -> Live Model Map")
    ap.add_argument("targets", nargs="*", help="fichiers .gguf/.safetensors ou dossiers à scanner")
    ap.add_argument("--endpoint", default=os.environ.get("BRIDGE_ENDPOINT", DEFAULT_ENDPOINT))
    ap.add_argument("--analyzer-cmd", help="commande de l'analyseur (défaut : ANALYZER_BIN, sinon npx)")
    ap.add_argument("--report", action="append", default=[], help="rapport JSON déjà sauvegardé (répétable)")
    ap.add_argument("--enrich", help="fichier JSON de métriques à fusionner (clé = id ou \"*\")")
    ap.add_argument("--dry-run", action="store_true", help="affiche les évènements sans les envoyer")
    ap.add_argument("--watch", type=float, metavar="SEC", help="rescanne les cibles toutes les SEC secondes")
    ap.add_argument("--timeout", type=float, default=300.0, help="délai max d'une inspection (s)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s", stream=sys.stderr,
    )
    if not args.targets and not args.report:
        ap.error("indiquez au moins une cible ou un --report")

    enrich: dict[str, Any] = {}
    if args.enrich:
        enrich = json.loads(Path(args.enrich).expanduser().read_text(encoding="utf-8"))

    ok = fail = 0
    for report_path in args.report:
        report = parse_json_output(Path(report_path).expanduser().read_text(encoding="utf-8"))
        o, f = process_report(report, args, enrich)
        ok, fail = ok + o, fail + f

    if args.targets:
        analyzer_cmd = resolve_analyzer_cmd(args.analyzer_cmd)
        seen: dict[Path, tuple[int, int]] = {}
        while True:
            o, f = scan_once(args, analyzer_cmd, enrich, seen)
            ok, fail = ok + o, fail + f
            if not args.watch:
                break
            log.info("%d envoyés, %d échecs ; prochain scan dans %ss", ok, fail, args.watch)
            try:
                time.sleep(args.watch)
            except KeyboardInterrupt:
                break

    log.info("terminé : %d évènement(s) envoyé(s), %d échec(s)", ok, fail)
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
