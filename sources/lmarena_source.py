"""LMArena (Chatbot Arena) ELO ratings for the Live Model Map.

Reads the public leaderboard dataset lmarena-ai/leaderboard-dataset (config
"text", split "latest", category "overall") through the Hugging Face
datasets-server API. Ratings are matched to models by name only when the names
are identical once case and punctuation are ignored ("Llama 3.1 8B Instruct" ↔
"Llama-3.1-8B-Instruct"); variants such as "(Thinking)" are not attached to the
base model, so some models stay without a rating rather than get a wrong one.
"""

import json
import re
import ssl
import urllib.request

try:
    import certifi
    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CONTEXT = ssl.create_default_context()

ROWS_URL = (
    "https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset"
    "&config=text&split=latest&offset={offset}&length=100"
)
MAX_PAGES = 120  # the whole split is ~11k rows; "overall" comes first


def normalize_name(name: str) -> str:
    return re.sub(r"[^a-z0-9.]", "", name.lower())


def _get_json(url: str):
    request = urllib.request.Request(url, headers={"User-Agent": "live-model-map/0.1"})
    with urllib.request.urlopen(request, timeout=60, context=SSL_CONTEXT) as resp:
        return json.load(resp)


def fetch_ratings() -> dict:
    """{"date": leaderboard date, "ratings": {normalized name: {...}}} for the overall text arena."""
    overall, seen_overall = [], False
    for page in range(MAX_PAGES):
        data = _get_json(ROWS_URL.format(offset=page * 100))
        rows = [r["row"] for r in data["rows"]]
        page_overall = [r for r in rows if r.get("category") == "overall"]
        overall += page_overall
        seen_overall = seen_overall or bool(page_overall)
        # Rows are grouped by category: stop once "overall" is behind us.
        if (seen_overall and len(page_overall) < len(rows)) or (page + 1) * 100 >= data["num_rows_total"]:
            break

    ratings: dict[str, dict] = {}
    for r in overall:
        key = normalize_name(r["model_name"])
        entry = {
            "name": r["model_name"],
            "rating": round(r["rating"]),
            "rank": int(r["rank"]) if r.get("rank") is not None else None,
            "votes": int(r["vote_count"]) if r.get("vote_count") is not None else None,
        }
        # Same normalized name twice: keep the better-supported rating.
        if key not in ratings or (entry["votes"] or 0) > (ratings[key]["votes"] or 0):
            ratings[key] = entry
    dates = sorted({r.get("leaderboard_publish_date") for r in overall if r.get("leaderboard_publish_date")})
    return {"date": dates[-1] if dates else None, "ratings": ratings}
