"""Statistics for the reasoning evaluation, in plain Python (no numpy).

Everything a score on the map is shown with: margins of error, "is this gap
real or luck?", rank correlation between downloads and quality, and the
Bradley-Terry scale that puts our results next to LMArena's.
"""

import math
import random


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """95 % margin of error for k right answers out of n (Wilson interval)."""
    if n == 0:
        return 0.0, 1.0
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, centre - half), min(1.0, centre + half)


def mcnemar_p(b: int, c: int) -> float:
    """Exact two-sided McNemar p-value.

    b = problems only model A got right, c = only model B. Under "no real
    difference" each of those b + c problems is a coin flip.
    """
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * tail)


def _percentiles(values: list[float]) -> tuple[float, float]:
    values = sorted(values)
    last = len(values) - 1
    return values[round(0.025 * last)], values[round(0.975 * last)]


def paired_bootstrap_diff(
    a: list[bool], b: list[bool], iters: int = 2000, seed: int = 0
) -> tuple[float, float, float]:
    """mean(a) - mean(b) on the same problems, with a 95 % bootstrap interval."""
    n = len(a)
    if n == 0:
        return 0.0, 0.0, 0.0
    diffs = [int(x) - int(y) for x, y in zip(a, b)]
    mean = sum(diffs) / n
    rng = random.Random(seed)
    samples = [sum(diffs[rng.randrange(n)] for _ in range(n)) / n for _ in range(iters)]
    lo, hi = _percentiles(samples)
    return mean, lo, hi


def _ranks(values: list[float]) -> list[float]:
    """1-based ranks, ties get the average of their ranks."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        for t in range(i, j + 1):
            ranks[order[t]] = (i + j) / 2 + 1
        i = j + 1
    return ranks


def _pearson(x: list[float], y: list[float]) -> float:
    n = len(x)
    mx, my = sum(x) / n, sum(y) / n
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y))
    sxx = sum((a - mx) ** 2 for a in x)
    syy = sum((b - my) ** 2 for b in y)
    if sxx == 0 or syy == 0:
        return 0.0
    return sxy / math.sqrt(sxx * syy)


def spearman(x: list[float], y: list[float]) -> float:
    """Do the two rankings agree? 1 = same order, 0 = unrelated, -1 = reversed."""
    return _pearson(_ranks(x), _ranks(y))


def bootstrap_spearman(
    x: list[float], y: list[float], iters: int = 2000, seed: int = 0
) -> tuple[float, float, float]:
    rho = spearman(x, y)
    n = len(x)
    rng = random.Random(seed)
    samples = []
    for _ in range(iters):
        idx = [rng.randrange(n) for _ in range(n)]
        samples.append(spearman([x[i] for i in idx], [y[i] for i in idx]))
    lo, hi = _percentiles(samples)
    return rho, lo, hi


def fit_linear(x: list[float], y: list[float]) -> tuple[float, float]:
    """Least-squares line y = slope * x + intercept."""
    n = len(x)
    mx, my = sum(x) / n, sum(y) / n
    sxx = sum((a - mx) ** 2 for a in x)
    slope = 0.0 if sxx == 0 else sum((a - mx) * (b - my) for a, b in zip(x, y)) / sxx
    return slope, my - slope * mx


def ols_residuals(x: list[float], y: list[float]) -> list[float]:
    """How far each point sits above (+) or below (-) the best-fit line."""
    slope, intercept = fit_linear(x, y)
    return [b - (slope * a + intercept) for a, b in zip(x, y)]


def bradley_terry(wins: dict[tuple[str, str], int], iters: int = 500) -> dict[str, float]:
    """Strength of each model from head-to-head wins, on an Elo-like scale centred on 0.

    wins[(a, b)] = problems a got right and b got wrong. Solved with the
    minorise-maximise updates of Hunter (2004). Every pair that met gets half a
    win each way, so a model that never won still gets a finite score.
    """
    players = sorted({p for pair in wins for p in pair})
    w: dict[tuple[str, str], float] = {pair: float(count) for pair, count in wins.items()}
    for a, b in {(min(a, b), max(a, b)) for a, b in wins}:
        w[(a, b)] = w.get((a, b), 0.0) + 0.5
        w[(b, a)] = w.get((b, a), 0.0) + 0.5
    total_wins = {p: sum(v for (a, _), v in w.items() if a == p) for p in players}
    games = {}
    for (a, b), v in w.items():
        key = (min(a, b), max(a, b))
        games[key] = games.get(key, 0.0) + v
    opponents: dict[str, list[tuple[str, float]]] = {p: [] for p in players}
    for (a, b), n in games.items():
        opponents[a].append((b, n))
        opponents[b].append((a, n))
    strength = {p: 1.0 for p in players}
    for _ in range(iters):
        new = {}
        for p in players:
            denom = sum(n / (strength[p] + strength[o]) for o, n in opponents[p])
            new[p] = total_wins[p] / denom if denom else strength[p]
        mean_log = sum(math.log(v) for v in new.values()) / len(new)
        new = {p: v / math.exp(mean_log) for p, v in new.items()}
        converged = max(abs(new[p] - strength[p]) for p in players) < 1e-9
        strength = new
        if converged:
            break
    return {p: 400 * math.log10(strength[p]) for p in players}
