"""Daily reasoning evaluation (run by .github/workflows/evaluate.yml).

    python pipeline/evaluate.py --models-url https://<user>.github.io/<repo>/data/models.json --out eval
    python pipeline/evaluate.py --models-url ... --dry-run --top 5     # fake model, spends nothing

1. Picks the most downloaded map models that OpenRouter serves.
2. Asks each one the paired problems it hasn't answered yet, stopping before
   the budget could be crossed (EVAL_BUDGET_USD, default 10 $).
3. Appends every raw answer to answers.jsonl and rewrites eval.json.
"""

import argparse
import json
import os
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from eval_problems import load_problems
from eval_runner import SSL_CONTEXT, FakeClient, OpenRouterClient, load_answers, run, spent_so_far
from eval_summary import summarize

OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models"
HF_API = "https://huggingface.co/api/models"
DEFAULT_BUDGET = 10.0


def _get_json(url: str, timeout: float = 60):
    request = urllib.request.Request(url, headers={"User-Agent": "live-model-map/0.1"})
    context = None if url.startswith("file:") else SSL_CONTEXT
    with urllib.request.urlopen(request, timeout=timeout, context=context) as resp:
        return json.load(resp)


def budget_from(arg: float | None) -> float:
    if arg is not None:
        return arg
    env = os.environ.get("EVAL_BUDGET_USD", "").strip()
    return float(env) if env else DEFAULT_BUDGET


def fetch_catalogue() -> dict[str, dict]:
    """{hugging face id (lowercase): {"openrouter_id", "price": ($/prompt token, $/completion token)}}.

    Paid listings are preferred over ":free" ones, which have tight rate limits.
    """
    out: dict[str, dict] = {}
    for entry in _get_json(OPENROUTER_MODELS)["data"]:
        repo = entry.get("hugging_face_id")
        pricing = entry.get("pricing") or {}
        try:
            price = (float(pricing["prompt"]), float(pricing["completion"]))
        except (KeyError, TypeError, ValueError):
            continue
        if not repo or min(price) < 0:
            continue
        current = out.get(repo.lower())
        if current is None or current["openrouter_id"].endswith(":free"):
            out[repo.lower()] = {"openrouter_id": entry["id"], "price": price}
    return out


def claimed_gsm8k(card_data: dict) -> float | None:
    """The GSM8K score the authors publish in their model card, as a fraction."""
    try:
        for index in card_data.get("model-index") or []:
            for result in index.get("results") or []:
                dataset = result.get("dataset") or {}
                label = f"{dataset.get('name', '')} {dataset.get('type', '')}".lower()
                if "gsm8k" in label and "symbolic" not in label:
                    value = float(result["metrics"][0]["value"])
                    return value / 100 if value > 1 else value
    except (AttributeError, KeyError, IndexError, TypeError, ValueError):
        return None
    return None


def fetch_claimed(model_ids: list[str]) -> dict[str, float | None]:
    claimed = {}
    for mid in model_ids:
        try:
            card = _get_json(f"{HF_API}/{urllib.parse.quote(mid)}?expand[]=cardData", timeout=30).get("cardData") or {}
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            card = {}
        claimed[mid] = claimed_gsm8k(card)
    return claimed


def main(argv: list[str] | None = None) -> Path:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--models-url", required=True, help="published models.json")
    parser.add_argument("--out", help="folder for answers.jsonl and eval.json (default: eval, or a temp folder with --dry-run)")
    parser.add_argument("--budget", type=float, help="spending cap in USD (default: EVAL_BUDGET_USD or 10)")
    parser.add_argument("--top", type=int, default=30, help="how many of the most downloaded served models")
    parser.add_argument("--dry-run", action="store_true", help="use a fake model; spends nothing")
    args = parser.parse_args(argv)

    out = Path(args.out) if args.out else (Path(tempfile.mkdtemp()) if args.dry_run else Path("eval"))
    budget = budget_from(args.budget)
    nodes = _get_json(args.models_url)["nodes"]
    catalogue = fetch_catalogue()
    served = [n for n in nodes if n["id"].lower() in catalogue]
    served.sort(key=lambda n: -((n.get("usage") or {}).get("download_count_24h") or 0))
    candidates = served[: args.top]

    problems = load_problems()
    if args.dry_run:
        client = FakeClient(0.9, 0.75, 0, problems)
    else:
        key = os.environ.get("OPENROUTER_API_KEY", "").strip()
        if not key:
            raise SystemExit("OPENROUTER_API_KEY is not set: add it as a repository secret (or use --dry-run).")
        client = OpenRouterClient(key)

    answers_path = out / "answers.jsonl"
    spent = spent_so_far(load_answers(answers_path))
    price = {catalogue[n["id"].lower()]["openrouter_id"]: catalogue[n["id"].lower()]["price"] for n in candidates}
    todo = [
        (n["id"], catalogue[n["id"].lower()]["openrouter_id"], p, variant)
        for n in candidates for p in problems for variant in ("known", "modified")
    ]
    spent = run(client, todo, answers_path, budget, spent, price)

    answers = load_answers(answers_path)
    evaluated = sorted({a["model_id"] for a in answers})
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    summary = summarize(answers, nodes, fetch_claimed(evaluated), now, budget=budget)
    (out / "eval.json").write_text(json.dumps(summary, indent=1))
    print(f"Evaluation {now}: {len(evaluated)} models, {len(answers)} answers, "
          f"{spent:.2f} $ spent of {budget:.2f} $ -> {out / 'eval.json'}")
    if summary["headline"]:
        print(f"Headline: {summary['headline']}")
    return out / "eval.json"


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()
