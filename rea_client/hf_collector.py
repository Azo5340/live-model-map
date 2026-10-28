"""Collect models from the Hugging Face Hub and push them to the Live Model Map.

    python hf_collector.py                     # every hour until Ctrl+C
    python hf_collector.py --once              # a single pass
    python hf_collector.py --limit 50 --sort downloads --interval 600

Per model it fetches the repo id, author, creation date, downloads and the
declared base model (cardData.base_model), which becomes parent_model_id.
Parents (and grandparents) are fetched too so the lineage links show up.

Price (and a fallback context window) comes from OpenRouter's public catalogue,
matched on the Hugging Face repo id; see openrouter_source.py.

Not provided by either source: speed, latency, ELO, live requests. Those fields
stay empty. The Hub's "downloads" counter covers the last 30 days, so
download_count_24h is an estimate (downloads / 30).

Standard library only (plus certifi if installed, for HTTPS certificates).
Set HF_TOKEN to raise rate limits and read gated model configs.
"""

import argparse
import json
import os
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

from concurrent.futures import ThreadPoolExecutor

from openrouter_source import fetch_openrouter, fetch_status
from push_to_live_map import push_to_live_map

HF_API = "https://huggingface.co/api/models"
HF_TOKEN = os.getenv("HF_TOKEN")
EXPAND = ["author", "createdAt", "downloads", "cardData", "likes"]

try:
    import certifi
    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CONTEXT = ssl.create_default_context()


def _get_json(url: str, timeout: float = 20):
    headers = {"Accept": "application/json", "User-Agent": "live-model-map/0.1"}
    if HF_TOKEN:
        headers["Authorization"] = f"Bearer {HF_TOKEN}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout, context=SSL_CONTEXT) as resp:
        return json.load(resp)


def _query(params: dict) -> str:
    pairs = list(params.items()) + [("expand[]", e) for e in EXPAND]
    return urllib.parse.urlencode(pairs)


def list_models(pipeline_tag: str, sort: str, limit: int) -> list[dict]:
    params = {"pipeline_tag": pipeline_tag, "sort": sort, "direction": "-1", "limit": str(limit)}
    return _get_json(f"{HF_API}?{_query(params)}")


def get_model(repo_id: str) -> dict | None:
    try:
        return _get_json(f"{HF_API}/{urllib.parse.quote(repo_id)}?{_query({})}")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403, 404):  # gated, private or deleted
            return None
        raise


# Context windows don't change between passes, so look each one up only once.
_context_cache: dict[str, int | None] = {}


def get_context_window(repo_id: str) -> int | None:
    """Read max_position_embeddings from the repo's config.json, if public."""
    if repo_id in _context_cache:
        return _context_cache[repo_id]
    url = f"https://huggingface.co/{urllib.parse.quote(repo_id)}/resolve/main/config.json"
    value = None
    try:
        config = _get_json(url, timeout=10)
        # Multimodal models nest the language model's config.
        for cfg in (config, config.get("text_config") or {}):
            for key in ("max_position_embeddings", "n_positions", "max_sequence_length", "seq_length"):
                if value is None and isinstance(cfg.get(key), int):
                    value = cfg[key]
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError, AttributeError):
        pass
    _context_cache[repo_id] = value
    return value


def base_model_of(hf_model: dict) -> str | None:
    base = (hf_model.get("cardData") or {}).get("base_model")
    if isinstance(base, list):
        base = base[0] if base else None
    if not isinstance(base, str) or "/" not in base or base == hf_model["id"]:
        return None
    return base


def to_live_map(hf_model: dict, openrouter: dict[str, dict], statuses: dict[str, tuple]) -> dict:
    repo_id = hf_model["id"]
    downloads_30d = hf_model.get("downloads")
    served = openrouter.get(repo_id.lower(), {})
    # Models not served on OpenRouter have no live status: leave it as is (None).
    status, status_detail = statuses.get(repo_id.lower()) or (None, None)
    return {
        "id": repo_id,
        "name": repo_id.split("/", 1)[1],
        "provider": hf_model.get("author") or repo_id.split("/", 1)[0],
        "parent_model_id": base_model_of(hf_model),
        "release_date": hf_model.get("createdAt"),
        "metrics": {
            # The model's own config wins; OpenRouter's served context is the fallback.
            "context_window": get_context_window(repo_id) or served.get("context_window"),
            "cost_per_1k_tokens": served.get("cost_per_1k_tokens"),
        },
        "usage_stats": {
            "download_count_24h": round(downloads_30d / 30) if downloads_30d is not None else None,
        },
        "status": status,
        "status_detail": status_detail,
    }


def collect(
    pipeline_tag: str,
    sort: str,
    limit: int,
    depth: int,
    use_openrouter: bool = True,
    openrouter_catalog: bool = False,
) -> list[dict]:
    openrouter: dict[str, dict] = {}
    if use_openrouter:
        try:
            openrouter = fetch_openrouter()
        except (urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError) as e:
            print(f"OpenRouter indisponible, prix ignorés pour cette passe : {e}")

    found = {m["id"]: m for m in list_models(pipeline_tag, sort, limit)}

    # Optionally add every open model OpenRouter serves, so priced models show up
    # even when they aren't trending on Hugging Face.
    if openrouter_catalog:
        known = {repo_id.lower() for repo_id in found}
        for repo_key in openrouter.keys() - known:
            model = get_model(repo_key)
            if model:
                found[model["id"]] = model

    # Walk up the lineage so parents exist on the map and links can be drawn.
    frontier = list(found.values())
    for _ in range(depth):
        parents = {base_model_of(m) for m in frontier} - set(found) - {None}
        frontier = []
        for parent_id in parents:
            parent = get_model(parent_id)
            if parent:
                found[parent["id"]] = parent
                frontier.append(parent)

    # One status lookup per model served on OpenRouter, a few at a time.
    served_keys = [k for k in (repo_id.lower() for repo_id in found) if k in openrouter]
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = pool.map(lambda k: fetch_status(openrouter[k]["openrouter_id"]), served_keys)
        statuses = {k: s for k, s in zip(served_keys, results) if s}

    return [to_live_map(m, openrouter, statuses) for m in found.values()]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--once", action="store_true", help="run a single pass and exit")
    parser.add_argument("--interval", type=float, default=3600, help="seconds between passes")
    parser.add_argument("--limit", type=int, default=30, help="models to list per pass")
    parser.add_argument("--sort", default="trendingScore", choices=["trendingScore", "downloads", "likes", "createdAt"])
    parser.add_argument("--pipeline-tag", default="text-generation")
    parser.add_argument("--depth", type=int, default=2, help="how many ancestor levels to fetch")
    parser.add_argument("--no-openrouter", action="store_true", help="skip OpenRouter prices")
    parser.add_argument("--openrouter-catalog", action="store_true",
                        help="also add every open model served on OpenRouter (~170 models, slower)")
    args = parser.parse_args()

    while True:
        try:
            models = collect(args.pipeline_tag, args.sort, args.limit, args.depth,
                             use_openrouter=not args.no_openrouter,
                             openrouter_catalog=args.openrouter_catalog)
            result = push_to_live_map(models, source="huggingface")
            if result:
                print(f"{len(models)} modèles collectés — ajoutés : {len(result['added'])}, "
                      f"mis à jour : {len(result['updated'])}")
            else:
                print(f"{len(models)} modèles collectés — rien de nouveau")
        except (urllib.error.URLError, RuntimeError) as e:
            print(f"Échec de la passe : {e}")
        if args.once:
            break
        time.sleep(args.interval)
