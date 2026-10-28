"""Push extracted AI-model data to the Live Model Map backend.

Standard library only, so it can be copied into any collector script.

Use as a library:

    from push_to_live_map import push_to_live_map
    push_to_live_map([{"id": "acme/foo-2", "name": "Foo 2", "provider": "Acme", ...}])

Or from the shell, with a JSON file (a single model, a list, or {"models": [...]}):

    python push_to_live_map.py models.json
    my_collector | python push_to_live_map.py -

Only models whose data changed since the last successful push are sent
(fingerprints are kept in .live_map_state.json next to this file).
"""

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

LIVE_MAP_URL = os.getenv("LIVE_MAP_URL", "http://localhost:8000/api/ingest/rea-event")
INGEST_TOKEN = os.getenv("LIVE_MAP_INGEST_TOKEN")  # must match backend INGEST_TOKEN if set
STATE_FILE = Path(os.getenv("LIVE_MAP_STATE", Path(__file__).with_name(".live_map_state.json")))

METRIC_KEYS = ("tokens_per_sec", "latency_ms", "cost_per_1k_tokens", "context_window", "elo_score")
USAGE_KEYS = ("download_count_24h", "active_requests_est")


def format_model(raw: dict) -> dict:
    """Map one extracted record onto the backend's AIModel schema.

    Edit this function if your collector uses different field names.
    """
    provider = raw.get("provider") or raw.get("org") or "unknown"
    name = raw.get("name") or raw["id"].split("/")[-1]
    model_id = raw.get("id") or f"{provider}/{name}".lower().replace(" ", "-")

    metrics_src = raw.get("metrics", raw)
    usage_src = raw.get("usage_stats") or raw.get("usage") or raw

    return {
        "id": model_id,
        "name": name,
        "provider": provider,
        "parent_model_id": raw.get("parent_model_id"),
        "release_date": raw.get("release_date"),
        "metrics": {k: metrics_src.get(k) for k in METRIC_KEYS},
        "usage_stats": {k: usage_src.get(k) for k in USAGE_KEYS},
        # operational | degraded | down | security_incident | unknown; None keeps the stored one.
        "status": raw.get("status"),
        "status_detail": raw.get("status_detail"),
    }


def _fingerprint(model: dict) -> str:
    return hashlib.sha256(json.dumps(model, sort_keys=True).encode()).hexdigest()


def _load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def push_to_live_map(
    raw_models: list[dict],
    alerts: list[dict] | None = None,
    *,
    source: str = "rea",
    only_changes: bool = True,
    url: str = LIVE_MAP_URL,
    timeout: float = 10,
) -> dict | None:
    """POST new or changed models (and optional alerts) to the Live Map.

    alerts: [{"message": "...", "level": "info|warning|critical", "model_id": "..."}]
    Returns the backend's response ({"added": [...], "updated": [...], ...}),
    or None if there was nothing new to send.
    """
    models = [format_model(m) for m in raw_models]
    state = _load_state()
    if only_changes:
        models = [m for m in models if state.get(m["id"]) != _fingerprint(m)]
    if not models and not alerts:
        return None

    body = json.dumps({
        "source": source,
        "detected_at": datetime.now(timezone.utc).isoformat(),
        "models": models,
        "alerts": alerts or [],
    }).encode()
    headers = {"Content-Type": "application/json"}
    if INGEST_TOKEN:
        headers["X-Ingest-Token"] = INGEST_TOKEN

    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            result = json.load(resp)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Live Map rejected the event ({e.code}): {e.read().decode()}") from e

    # Only remember fingerprints once the backend has accepted them.
    state.update({m["id"]: _fingerprint(m) for m in models})
    STATE_FILE.write_text(json.dumps(state, indent=2))
    return result


def _read_input(path: str) -> tuple[list[dict], list[dict]]:
    text = sys.stdin.read() if path == "-" else Path(path).read_text()
    data = json.loads(text)
    if isinstance(data, list):
        return data, []
    if "models" in data:
        return data["models"], data.get("alerts", [])
    return [data], []


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("input", help="JSON file with extracted models, or - for stdin")
    parser.add_argument("--all", action="store_true", help="send every model, not only changes")
    parser.add_argument("--source", default="rea")
    args = parser.parse_args()

    models, alerts = _read_input(args.input)
    result = push_to_live_map(models, alerts, source=args.source, only_changes=not args.all)
    print(json.dumps(result, indent=2) if result else "Nothing new to push.")
