"""Price and served context window for open models listed on OpenRouter.

OpenRouter's public catalogue (no API key needed) tags many open models with
their Hugging Face repo id, which is how we join the two sources.

cost_per_1k_tokens is a blended price: 3 input tokens for 1 output token,
in USD per 1,000 tokens.
"""

import json
import ssl
import urllib.error
import urllib.request

try:
    import certifi
    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CONTEXT = ssl.create_default_context()

OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models"


def _blended_cost_per_1k(pricing: dict) -> float | None:
    try:
        prompt = float(pricing["prompt"])
        completion = float(pricing["completion"])
    except (KeyError, TypeError, ValueError):
        return None
    if prompt < 0 or completion < 0:  # routers with variable pricing report -1
        return None
    return round((3 * prompt + completion) / 4 * 1000, 6)


def _get_json(url: str, timeout: float = 30):
    request = urllib.request.Request(url, headers={"User-Agent": "live-model-map/0.1"})
    with urllib.request.urlopen(request, timeout=timeout, context=SSL_CONTEXT) as resp:
        return json.load(resp)


def fetch_status(openrouter_id: str) -> tuple[str, str, float] | None:
    """Availability of a model across the providers serving it on OpenRouter.

    The model counts as usable if at least one provider serves it, so the best
    provider's uptime over the last 30 minutes decides (the 5-minute figure
    flaps too much for a check every 10 minutes):
    >= 95% operational, > 0% degraded, otherwise (or no provider left) down.
    Returns (status, human-readable detail, best uptime in %), or None if the lookup failed.
    """
    # Keep any ":free" suffix: free-only models have no endpoints under the bare slug.
    try:
        endpoints = _get_json(f"{OPENROUTER_MODELS}/{openrouter_id}/endpoints", timeout=15)["data"]["endpoints"]
    except (urllib.error.URLError, TimeoutError, KeyError, TypeError, json.JSONDecodeError):
        return None
    if not endpoints:
        return "down", "Aucun fournisseur ne sert ce modèle sur OpenRouter", 0.0

    uptimes = [
        e.get("uptime_last_30m") if e.get("uptime_last_30m") is not None else e.get("uptime_last_5m")
        for e in endpoints
    ]
    uptimes = [u for u in uptimes if u is not None]
    if not uptimes:
        return None
    best = max(uptimes)
    healthy = sum(1 for u in uptimes if u >= 95)
    detail = f"{healthy}/{len(endpoints)} fournisseurs OK, meilleure dispo 30 min : {best:.0f}%"
    availability = round(float(best), 1)
    if best >= 95:
        return "operational", detail, availability
    if best > 0:
        return "degraded", detail, availability
    return "down", detail, availability


def fetch_openrouter() -> dict[str, dict]:
    """Return {hugging face repo id (lowercase): {"cost_per_1k_tokens", "context_window", "openrouter_id"}}."""
    catalogue = _get_json(OPENROUTER_MODELS)["data"]

    by_repo: dict[str, dict] = {}
    for entry in catalogue:
        repo = entry.get("hugging_face_id")
        if not repo:
            continue
        info = {
            "cost_per_1k_tokens": _blended_cost_per_1k(entry.get("pricing") or {}),
            "context_window": entry.get("context_length"),
            "openrouter_id": entry["id"],
        }
        key = repo.lower()
        # A model can be listed several times (e.g. "x/y" and "x/y:free");
        # keep the paid listing so the map doesn't show a free tier as the price.
        current = by_repo.get(key)
        if current is None or current["openrouter_id"].endswith(":free"):
            by_repo[key] = info
    return by_repo
