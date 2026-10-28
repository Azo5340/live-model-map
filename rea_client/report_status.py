"""Set a model's status on the Live Map by hand.

    python report_status.py org/model security_incident "Fuite du prompt système trouvée via REA"
    python report_status.py org/model down "Plus de réponse depuis 14h"
    python report_status.py org/model operational          # clears an incident

Statuses: operational, degraded, down, security_incident, unknown.
A security incident stays on the map until it is cleared here; the collectors
can't overwrite it.
"""

import argparse
import json
import urllib.error
import urllib.parse
import urllib.request

from push_to_live_map import INGEST_TOKEN, LIVE_MAP_URL

STATUSES = ["operational", "degraded", "down", "security_incident", "unknown"]
API_ROOT = LIVE_MAP_URL.split("/api/", 1)[0]


def report_status(model_id: str, status: str, detail: str | None = None, source: str = "manual") -> dict:
    url = f"{API_ROOT}/api/models/{urllib.parse.quote(model_id, safe='/')}/status"
    body = json.dumps({"status": status, "detail": detail, "source": source}).encode()
    headers = {"Content-Type": "application/json"}
    if INGEST_TOKEN:
        headers["X-Ingest-Token"] = INGEST_TOKEN
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=10) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Refusé par la Live Map ({e.code}) : {e.read().decode()}") from e


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("model_id")
    parser.add_argument("status", choices=STATUSES)
    parser.add_argument("detail", nargs="?", help="what happened, shown on the map")
    parser.add_argument("--source", default="manual", help="who reports it, e.g. rea")
    args = parser.parse_args()

    model = report_status(args.model_id, args.status, args.detail, args.source)
    print(f"{model['id']} → {model['status']}" + (f" ({model['status_detail']})" if model["status_detail"] else ""))
