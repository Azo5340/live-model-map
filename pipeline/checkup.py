"""One check-up pass of the Live Model Map (run by GitHub Actions every ~10 min).

    python pipeline/checkup.py --out frontend/public/data
    python pipeline/checkup.py --out frontend/public/data --previous-url https://<user>.github.io/<repo>/data

1. Loads the previous state: from the published site (--previous-url), or from --out.
2. Collects Hugging Face (trending + lineage) and OpenRouter (price + live status).
   Every pass checks the status of every model served on OpenRouter; every
   ~6 hours it also refreshes every known model's Hugging Face data.
3. Applies pipeline/status_overrides.json (security incidents reported by hand).
4. Writes models.json, events.json, checkups.json (history) and todo.json.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "sources"))

import hf_collector as hf  # noqa: E402
from openrouter_source import SSL_CONTEXT, fetch_openrouter, fetch_status  # noqa: E402

OVERRIDES_FILE = Path(__file__).with_name("status_overrides.json")
STATUSES = {"operational", "degraded", "down", "security_incident", "unknown"}
METRIC_KEYS = ("tokens_per_sec", "latency_ms", "cost_per_1k_tokens", "context_window", "elo_score")
STATE_FILES = ("models", "events", "checkups")

TRENDING_LIMIT = 30
LINEAGE_DEPTH = 2
# Re-reading every known model on Hugging Face (downloads) is the expensive part,
# so it only happens every few hours; statuses are still checked every pass.
FULL_REFRESH_EVERY = timedelta(hours=6) - timedelta(minutes=5)
FORGET_AFTER = timedelta(days=30)  # drop models no source has returned for this long
NEW_MODEL_TODO_FOR = timedelta(days=3)
MAX_EVENTS = 300
MAX_CHECKUPS = 500
WORKERS = 8  # OpenRouter status lookups
HF_WORKERS = 4  # gentler on Hugging Face's rate limit


def iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds").replace("+00:00", "Z")


def parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


# --- previous state ---------------------------------------------------------

def _fetch_previous(url: str, name: str):
    request = urllib.request.Request(
        f"{url.rstrip('/')}/{name}.json?t={int(time.time())}",
        headers={"User-Agent": "live-model-map/0.1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30, context=SSL_CONTEXT) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        if e.code == 404:  # site not published yet: first run
            return None
        raise SystemExit(f"Impossible de lire l'état précédent ({name}.json, HTTP {e.code}) : passe annulée.")
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        # Never start from scratch because of a network blip: that would wipe the history.
        raise SystemExit(f"Impossible de lire l'état précédent ({name}.json) : {e}. Passe annulée.")


def load_previous(out: Path, url: str | None) -> dict:
    previous = {}
    for name in STATE_FILES:
        local = out / f"{name}.json"
        if url:
            previous[name] = _fetch_previous(url, name)
        elif local.exists():
            previous[name] = json.loads(local.read_text())
        else:
            previous[name] = None
    return previous


def load_overrides() -> tuple[dict[str, dict], list[str]]:
    if not OVERRIDES_FILE.exists():
        return {}, []
    try:
        models = json.loads(OVERRIDES_FILE.read_text()).get("models", {})
    except json.JSONDecodeError as e:
        return {}, [f"status_overrides.json illisible : {e}"]
    valid, errors = {}, []
    for model_id, entry in models.items():
        if entry.get("status") not in STATUSES:
            errors.append(f"status_overrides.json : état invalide pour {model_id} ({entry.get('status')})")
            continue
        valid[model_id.lower()] = entry
    return valid, errors


# --- collection -------------------------------------------------------------

def normalize(record: dict) -> dict:
    """Collector record -> the shape the frontend reads."""
    release = record.get("release_date")
    return {
        "id": record["id"],
        "name": record["name"],
        "provider": record["provider"],
        "parent_model_id": record.get("parent_model_id"),
        "release_date": release[:10] if release else None,
        "metrics": {k: record["metrics"].get(k) for k in METRIC_KEYS},
        "usage": {
            "download_count_24h": record["usage_stats"].get("download_count_24h"),
            "active_requests_est": None,
        },
    }


def collect(previous_models: dict, full: bool, errors: list[str]):
    # Context windows never change: reuse what we already know instead of re-reading config.json.
    for model_id, model in previous_models.items():
        if model["metrics"].get("context_window"):
            hf._context_cache[model_id] = model["metrics"]["context_window"]

    try:
        openrouter = fetch_openrouter()
    except Exception as e:  # noqa: BLE001 - one source down must not stop the pass
        openrouter = {}
        errors.append(f"OpenRouter (catalogue) : {e}")

    fetched: dict[str, dict] = {}
    # Once Hugging Face answers 429 (rate limit), stop asking for this pass: what's
    # left is retried next pass and the map keeps the data it already has.
    hf_limit = {"hit": False, "postponed": 0}

    def hf_call(label: str, fn, *args):
        if hf_limit["hit"]:
            hf_limit["postponed"] += 1
            return None
        try:
            return fn(*args)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                hf_limit["hit"] = True
                hf_limit["postponed"] += 1
            else:
                errors.append(f"Hugging Face {label} : {e}")
        except Exception as e:  # noqa: BLE001 - one source down must not stop the pass
            errors.append(f"Hugging Face {label} : {e}")
        return None

    for model in hf_call("(tendances)", hf.list_models, "text-generation", "trendingScore", TRENDING_LIMIT) or []:
        fetched[model["id"]] = model

    def fetch_all(repo_ids):
        with ThreadPoolExecutor(max_workers=HF_WORKERS) as pool:
            found = [m for m in pool.map(lambda r: hf_call(r, hf.get_model, r), sorted(repo_ids)) if m]
        for model in found:
            fetched[model["id"]] = model
        return found

    known = {k.lower() for k in previous_models}
    have = lambda: {k.lower() for k in fetched}  # noqa: E731
    # Open models served on OpenRouter: new ones every pass, all of them on a full refresh.
    wanted = {r for r in openrouter if full or r not in known} - have()
    if full:
        wanted |= {k for k in previous_models if k.lower() not in have()}
    frontier = fetch_all(wanted) + list(fetched.values())

    # Walk up the lineage so parents exist and links can be drawn.
    for _ in range(LINEAGE_DEPTH):
        parents = {hf.base_model_of(m) for m in frontier} - {None}
        parents = {p for p in parents if p.lower() not in have() and (full or p.lower() not in known)}
        if not parents:
            break
        frontier = fetch_all(parents)

    if hf_limit["hit"]:
        errors.append(
            f"Hugging Face : limite de requêtes atteinte, {hf_limit['postponed']} requêtes "
            "reportées à la prochaine passe (ajoute un HF_TOKEN pour un quota plus large)"
        )

    # Live status for every model OpenRouter serves (new and already known).
    served = {k.lower() for k in set(previous_models) | set(fetched)} & set(openrouter)
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        keys = sorted(served)
        results = pool.map(lambda k: fetch_status(openrouter[k]["openrouter_id"]), keys)
        statuses = {k: s for k, s in zip(keys, results) if s}

    return fetched, openrouter, statuses


# --- merge, diff, outputs ---------------------------------------------------

def significant(model: dict) -> tuple:
    """Fields whose change is worth an event (downloads move every pass and are ignored)."""
    m = model["metrics"]
    return (model["name"], model["provider"], model.get("parent_model_id"), model.get("release_date"),
            m.get("cost_per_1k_tokens"), m.get("context_window"), m.get("elo_score"))


def event(kind: str, ts: str, model: dict, previous_status: str | None = None) -> dict:
    payload = {"source": "checkup", "model": public(model)}
    if previous_status is not None:
        payload["previous_status"] = previous_status
    return {"type": kind, "ts": ts, "payload": payload}


def public(model: dict) -> dict:
    return {k: v for k, v in model.items() if k != "last_seen"}


def build_todo(models: list[dict], now: datetime) -> list[dict]:
    titles = {
        "security_incident": "Faille de sécurité",
        "down": "En panne",
        "degraded": "Dégradé",
        "new_model": "Nouveau modèle",
    }
    items = []
    for m in models:
        status = m["status"]
        if status in ("security_incident", "down", "degraded"):
            items.append({
                "id": f"{status}:{m['id']}:{m['status_since']}",
                "kind": status, "title": titles[status], "model_id": m["id"], "model_name": m["name"],
                "detail": m.get("status_detail"), "since": m["status_since"],
            })
        if m.get("first_seen") and now - parse(m["first_seen"]) < NEW_MODEL_TODO_FOR:
            items.append({
                "id": f"new_model:{m['id']}",
                "kind": "new_model", "title": titles["new_model"], "model_id": m["id"], "model_name": m["name"],
                "detail": m["provider"], "since": m["first_seen"],
            })
    order = {"security_incident": 0, "down": 1, "degraded": 2, "new_model": 3}
    items.sort(key=lambda i: i["since"], reverse=True)
    items.sort(key=lambda i: order[i["kind"]])
    return items


def checkup(out: Path, previous_url: str | None) -> dict:
    started = datetime.now(timezone.utc)
    now = iso(started)
    errors: list[str] = []

    previous = load_previous(out, previous_url)
    previous_models = {m["id"]: m for m in (previous["models"] or {}).get("nodes", [])}
    events = previous["events"] or []
    checkups = previous["checkups"] or []
    initial = not previous_models
    last_full = next((c["ts"] for c in checkups if c.get("full")), None)
    full = initial or last_full is None or started - parse(last_full) >= FULL_REFRESH_EVERY

    fetched, openrouter, statuses = collect(previous_models, full, errors)
    overrides, override_errors = load_overrides()
    errors += override_errors

    merged = {mid: {**m, "metrics": dict(m["metrics"])} for mid, m in previous_models.items()}
    for mid, raw in fetched.items():
        merged[mid] = {**merged.get(mid, {}), **normalize(hf.to_live_map(raw, openrouter, statuses))}
        merged[mid]["last_seen"] = now

    for mid, m in merged.items():
        served = openrouter.get(mid.lower())
        if served:
            m["last_seen"] = now
            m["metrics"]["cost_per_1k_tokens"] = served["cost_per_1k_tokens"]
            m["metrics"]["context_window"] = m["metrics"].get("context_window") or served["context_window"]
            status = statuses.get(mid.lower())
            if status:  # lookup failed: keep the previous status
                m["status"], m["status_detail"] = status
        elif openrouter:  # catalogue loaded and the model isn't on it: no live status
            m["status"], m["status_detail"] = "unknown", None
        override = overrides.get(mid.lower())
        if override:
            m["status"], m["status_detail"] = override["status"], override.get("detail")
        m["status"] = m.get("status") or "unknown"
        m.setdefault("status_detail", None)

    for model_id in overrides.keys() - {k.lower() for k in merged}:
        errors.append(f"status_overrides.json : modèle inconnu {model_id}")

    # Forget models no source has returned for a long time (unless flagged by hand).
    cutoff = started - FORGET_AFTER
    merged = {
        mid: m for mid, m in merged.items()
        if mid.lower() in overrides or parse(m.get("last_seen", now)) >= cutoff
    }

    added, status_changes, metric_changes, new_events = [], [], 0, []
    for mid, m in merged.items():
        old = previous_models.get(mid)
        if old is None:
            # On the very first pass everything is "new": don't flood the feed and to-do list.
            m["first_seen"] = None if initial else now
            m["status_since"] = now
            m["updated_at"] = now
            if not initial:
                added.append(mid)
                new_events.append(event("MODEL_ADDED", now, m))
            continue
        m["first_seen"] = old.get("first_seen")
        # A status becoming known as "operational" isn't news; anything else is.
        status_changed = m["status"] != old.get("status") and not (
            old.get("status") == "unknown" and m["status"] == "operational"
        )
        changed = significant(m) != significant(old)
        m["status_since"] = now if m["status"] != old.get("status") else old.get("status_since", now)
        m["updated_at"] = now if (status_changed or changed) else old.get("updated_at", now)
        if status_changed:
            status_changes.append({"id": mid, "name": m["name"], "from": old.get("status"), "to": m["status"]})
            new_events.append(event("STATUS_CHANGED", now, m, previous_status=old.get("status")))
        elif changed:
            metric_changes += 1
            new_events.append(event("METRICS_UPDATED", now, m))

    nodes = sorted(merged.values(), key=lambda m: m["id"].lower())
    links = [
        {"source": m["parent_model_id"], "target": m["id"]}
        for m in nodes if m.get("parent_model_id") in merged
    ]
    record = {
        "ts": now,
        "duration_s": round((datetime.now(timezone.utc) - started).total_seconds(), 1),
        "full": full,
        "initial": initial,
        "total": len(nodes),
        "checked_status": len(statuses),
        "added": [{"id": mid, "name": merged[mid]["name"]} for mid in added[:50]],
        "added_count": len(added),
        "status_changes": status_changes[:50],
        "metric_changes": metric_changes,
        "errors": errors[:20],
        "error_count": len(errors),
    }

    out.mkdir(parents=True, exist_ok=True)
    outputs = {
        "models": {"generated_at": now, "nodes": nodes, "links": links},
        "events": (new_events + events)[:MAX_EVENTS],
        "checkups": ([record] + checkups)[:MAX_CHECKUPS],
        "todo": {"generated_at": now, "items": build_todo(nodes, started)},
    }
    for name, data in outputs.items():
        (out / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    return record


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=ROOT / "frontend" / "public" / "data")
    parser.add_argument("--previous-url", help="published data folder to continue from (in CI)")
    args = parser.parse_args()

    r = checkup(args.out, args.previous_url)
    print(f"Check-up {r['ts']} ({'complet' if r['full'] else 'rapide'}, {r['duration_s']} s) : "
          f"{r['total']} modèles, {r['checked_status']} états vérifiés, "
          f"{r['added_count']} nouveaux, {len(r['status_changes'])} changements d'état, "
          f"{r['error_count']} erreurs")
    for err in r["errors"]:
        print("  !", err)
