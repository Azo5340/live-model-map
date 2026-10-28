"""Performance deltas between two models."""

from .schemas import AIModel, Comparison, MetricDelta

# metric -> (higher_is_better, "better" wording, "worse" wording)
METRICS = {
    "tokens_per_sec": (True, "plus rapide", "plus lent"),
    "latency_ms": (False, "de latence en moins", "de latence en plus"),
    "cost_per_1k_tokens": (False, "moins cher", "plus cher"),
    "context_window": (True, "de contexte en plus", "de contexte en moins"),
    "elo_score": (True, "d'ELO en plus", "d'ELO en moins"),
}


def compare(model: AIModel, target: AIModel) -> Comparison:
    deltas = []
    for metric, (higher_better, better_word, worse_word) in METRICS.items():
        value = getattr(model.metrics, metric)
        target_value = getattr(target.metrics, metric)

        if value is None or target_value is None or target_value == 0:
            deltas.append(MetricDelta(
                metric=metric, value=value, target_value=target_value,
                delta_pct=None, better=None, label="n/a",
            ))
            continue

        delta_pct = (value - target_value) / target_value * 100
        if delta_pct == 0:
            better, label = None, "identique"
        else:
            better = (delta_pct > 0) == higher_better
            word = better_word if better else worse_word
            label = f"{abs(delta_pct):.0f}% {word}"
            label = ("+" if better else "-") + label

        deltas.append(MetricDelta(
            metric=metric, value=value, target_value=target_value,
            delta_pct=round(delta_pct, 2), better=better, label=label,
        ))

    return Comparison(model_id=model.id, target_id=target.id, deltas=deltas)
