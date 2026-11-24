"""Turns raw answers into the numbers the site shows (eval.json).

Only claims the statistics support are made: "remembers answers" needs a drop
that is clearly more than chance, "tied" means the gap could be luck, and the
headline is only written when one of its rules actually holds.
"""

import math
import random

from eval_stats import (
    bootstrap_spearman, bradley_terry, fit_linear, mcnemar_p, ols_residuals, paired_bootstrap_diff, wilson,
)

MIN_FOR_MEMORISES = 30  # answers per set before a drop can be called
MIN_ARENA_OVERLAP = 5  # models with both scores before putting them on one scale
MIN_FOR_POPULARITY = 10  # models with a quality score before correlating with downloads
QUALITY_RESAMPLES = 200


def _score(answers: list[dict]) -> dict:
    k, n = sum(a["correct"] for a in answers), len(answers)
    lo, hi = wilson(k, n)
    return {"k": k, "n": n, "lo": lo, "hi": hi}


def _wins(correct: dict[str, dict[tuple, bool]], items: list[tuple]) -> dict[tuple[str, str], int]:
    wins: dict[tuple[str, str], int] = {}
    models = sorted(correct)
    for i, a in enumerate(models):
        for b in models[i + 1:]:
            ab = ba = 0
            for item in items:
                x, y = correct[a].get(item), correct[b].get(item)
                if x is None or y is None:
                    continue
                ab += x and not y
                ba += y and not x
            wins[(a, b)] = ab
            wins[(b, a)] = ba
    return wins


def _measured_quality(correct: dict[str, dict[tuple, bool]]) -> dict[str, tuple[float, float, float]]:
    """Bradley-Terry score per model, with a 95 % interval from resampling problems."""
    if len(correct) < 2:
        return {}
    items = sorted({item for c in correct.values() for item in c})
    point = bradley_terry(_wins(correct, items))
    pids = sorted({pid for pid, _ in items})
    by_pid = {pid: [it for it in items if it[0] == pid] for pid in pids}
    rng = random.Random(0)
    samples: dict[str, list[float]] = {m: [] for m in point}
    for _ in range(QUALITY_RESAMPLES):
        resampled = [it for _ in pids for it in by_pid[pids[rng.randrange(len(pids))]]]
        for m, v in bradley_terry(_wins(correct, resampled), iters=200).items():
            samples[m].append(v)
    out = {}
    for m, v in point.items():
        s = sorted(samples[m])
        out[m] = (v, s[round(0.025 * (len(s) - 1))], s[round(0.975 * (len(s) - 1))])
    return out


def summarize(answers: list[dict], models: list[dict], claimed: dict[str, float | None], now: str,
              budget: float = 10) -> dict:
    nodes = {m["id"]: m for m in models}
    downloads = {mid: (m.get("usage") or {}).get("download_count_24h") or 0 for mid, m in nodes.items()}
    arena = {mid: (m.get("metrics") or {}).get("elo_score") for mid, m in nodes.items()}
    arena = {mid: v for mid, v in arena.items() if v is not None}

    by_model: dict[str, list[dict]] = {}
    for a in answers:
        by_model.setdefault(a["model_id"], []).append(a)
    correct = {mid: {(a["pid"], a["variant"]): bool(a["correct"]) for a in rows} for mid, rows in by_model.items()}

    entries: dict[str, dict] = {}
    for mid, rows in by_model.items():
        known = [a for a in rows if a["variant"] == "known"]
        modified = [a for a in rows if a["variant"] == "modified"]
        k_by, m_by = {a["pid"]: a["correct"] for a in known}, {a["pid"]: a["correct"] for a in modified}
        paired = sorted(k_by.keys() & m_by.keys())
        drop = None
        if paired:
            mean, lo, hi = paired_bootstrap_diff([k_by[p] for p in paired], [m_by[p] for p in paired])
            drop = {"mean": mean, "lo": lo, "hi": hi}
        entries[mid] = {
            "known": _score(known),
            "modified": _score(modified),
            "drop": drop,
            "memorises": bool(
                drop and drop["lo"] > 0 and len(known) >= MIN_FOR_MEMORISES and len(modified) >= MIN_FOR_MEMORISES
            ),
            "truncated": sum(bool(a.get("truncated")) for a in rows),
            "claimed_gsm8k": claimed.get(mid),
            "quality": None,
            "underrated": None,
            "tied_with": [],
            "downloads": downloads.get(mid, 0),
        }

    # Tied = the gap between two models could be luck (McNemar, all answers pooled).
    measured = sorted(entries)
    for i, a in enumerate(measured):
        for b in measured[i + 1:]:
            shared = correct[a].keys() & correct[b].keys()
            ab = sum(correct[a][i] and not correct[b][i] for i in shared)
            ba = sum(correct[b][i] and not correct[a][i] for i in shared)
            if mcnemar_p(ab, ba) >= 0.05:
                entries[a]["tied_with"].append(b)
                entries[b]["tied_with"].append(a)

    # One quality scale: Bradley-Terry on our answers, mapped onto LMArena when enough models have both.
    bt = _measured_quality(correct)
    overlap = [m for m in bt if m in arena]
    scale = "arena" if len(overlap) >= MIN_ARENA_OVERLAP else "separate"
    if scale == "arena":
        slope, intercept = fit_linear([bt[m][0] for m in overlap], [arena[m] for m in overlap])
        for mid, (v, lo, hi) in bt.items():
            mapped = [slope * x + intercept for x in (v, lo, hi)]
            value, lo2, hi2 = mapped[0], min(mapped[1:]), max(mapped[1:])
            source = "measured"
            if mid in arena:  # both: average the two, keep the width of our measurement
                shift = (arena[mid] - value) / 2
                value, lo2, hi2, source = value + shift, lo2 + shift, hi2 + shift, "both"
            entries[mid]["quality"] = {"value": value, "lo": lo2, "hi": hi2, "source": source}
        for mid, rating in arena.items():
            if mid not in entries:
                entries[mid] = {
                    "known": None, "modified": None, "drop": None, "memorises": False, "truncated": 0,
                    "claimed_gsm8k": claimed.get(mid), "underrated": None, "tied_with": [],
                    "downloads": downloads.get(mid, 0),
                    "quality": {"value": rating, "lo": None, "hi": None, "source": "arena"},
                }
    else:
        for mid, (v, lo, hi) in bt.items():
            entries[mid]["quality"] = {"value": v, "lo": lo, "hi": hi, "source": "measured"}

    rated = [m for m, e in entries.items() if e["quality"]]
    if len(rated) >= 3:
        x = [math.log10(entries[m]["downloads"] + 1) for m in rated]
        for m, r in zip(rated, ols_residuals(x, [entries[m]["quality"]["value"] for m in rated])):
            entries[m]["underrated"] = r

    popularity = None
    if len(rated) >= MIN_FOR_POPULARITY:
        rho, lo, hi = bootstrap_spearman([entries[m]["downloads"] for m in rated],
                                         [entries[m]["quality"]["value"] for m in rated])
        popularity = {"spearman": rho, "lo": lo, "hi": hi, "n": len(rated)}

    summary = {
        "generated_at": now,
        "budget_usd": budget,
        "spent_usd": round(sum(a.get("cost") or 0 for a in answers), 6),
        "problems": len({a["pid"] for a in answers}),
        "scale": scale,
        "popularity": popularity,
        "names": {mid: nodes[mid]["name"] for mid in entries if mid in nodes},
        "models": entries,
    }
    summary["headline"] = headline(summary)
    return summary


def headline(summary: dict) -> str | None:
    models = summary.get("models") or {}
    names = summary.get("names") or {}

    # 1. Popular models beaten, beyond doubt, by a model with 10x fewer downloads.
    rated = {m: e for m, e in models.items() if e.get("quality") and e["quality"].get("lo") is not None}
    beaten = [
        m for m, e in rated.items()
        if any(
            o["downloads"] * 10 <= e["downloads"] and o["quality"]["lo"] > e["quality"]["hi"]
            for other, o in rated.items() if other != m
        )
    ]
    if beaten:
        return (f"{len(beaten)} of the {len(rated)} most downloaded models reason worse than "
                f"a model with 10× fewer downloads.")

    # 2. The clearest case of remembering answers.
    remembering = [(e["drop"]["mean"], m) for m, e in models.items() if e.get("memorises")]
    if remembering:
        mean, m = max(remembering)
        return f"{names.get(m, m)} drops {round(100 * mean)} points when only the numbers change."

    # 3. Downloads and quality barely related.
    p = summary.get("popularity")
    if p and p["lo"] <= 0 <= p["hi"]:
        return f"Downloads barely predict reasoning (ρ = {p['spearman']:.2f}, 95 % CI {p['lo']:.2f} to {p['hi']:.2f})."
    return None
