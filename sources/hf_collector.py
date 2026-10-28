"""Hugging Face Hub source for the Live Model Map (used by pipeline/checkup.py).

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

import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request

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
    """One model's metadata, including Hugging Face's own security scan of its files."""
    try:
        return _get_json(f"{HF_API}/{urllib.parse.quote(repo_id)}?{_query({'securityStatus': 'true'})}")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403, 404):  # gated, private or deleted
            return None
        raise


def get_avatar(owner: str) -> str | None:
    """The logo an organization (or user) set on Hugging Face, or None if it has none.

    Generated placeholder avatars (huggingface.co/avatars/...) are ignored: they
    aren't logos, and only the avatar CDN allows cross-origin texture loading.
    """
    for kind in ("organizations", "users"):
        try:
            url = _get_json(f"https://huggingface.co/api/{kind}/{urllib.parse.quote(owner)}/avatar").get("avatarUrl")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                continue
            raise
        return url if isinstance(url, str) and url.startswith("https://cdn-avatars.huggingface.co/") else None
    return None


# Levels Hugging Face's scanners assign to files. "caution" mostly flags plain
# Python scripts shipped with the model, so it isn't treated as an incident.
SECURITY_ISSUE_LEVELS = ("unsafe", "suspicious")


def security_of(hf_model: dict) -> dict | None:
    """Hugging Face's malware / unsafe-pickle scan result, or None if it wasn't fetched."""
    scan = hf_model.get("securityRepoStatus")
    if scan is None:
        return None
    issues = [
        {"path": f.get("path"), "level": f.get("level")}
        for f in scan.get("filesWithIssues") or []
        if f.get("level") in SECURITY_ISSUE_LEVELS
    ]
    return {"scanned": bool(scan.get("scansDone")), "issues": issues}


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
    status, status_detail, _availability = statuses.get(repo_id.lower()) or (None, None, None)
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
