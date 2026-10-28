import type { AIModel, Comparison, MetricDelta, Metrics } from "./types";

// metric -> [higher is better, "better" wording, "worse" wording]
const METRICS: Record<keyof Metrics, [boolean, string, string]> = {
  tokens_per_sec: [true, "plus rapide", "plus lent"],
  latency_ms: [false, "de latence en moins", "de latence en plus"],
  cost_per_1k_tokens: [false, "moins cher", "plus cher"],
  context_window: [true, "de contexte en plus", "de contexte en moins"],
  elo_score: [true, "d'ELO en plus", "d'ELO en moins"],
  availability_pct: [true, "plus disponible", "moins disponible"],
};

/** Performance deltas of `model` against `target` ("+20% plus rapide"…). */
export function compare(model: AIModel, target: AIModel): Comparison {
  const deltas: MetricDelta[] = (Object.keys(METRICS) as (keyof Metrics)[]).map((metric) => {
    const [higherBetter, betterWord, worseWord] = METRICS[metric];
    const value = model.metrics[metric] ?? null;
    const targetValue = target.metrics[metric] ?? null;

    if (value == null || targetValue == null || targetValue === 0) {
      return { metric, value, target_value: targetValue, delta_pct: null, better: null, label: "n/a" };
    }
    const deltaPct = ((value - targetValue) / targetValue) * 100;
    if (deltaPct === 0) {
      return { metric, value, target_value: targetValue, delta_pct: 0, better: null, label: "identique" };
    }
    const better = deltaPct > 0 === higherBetter;
    const label = `${better ? "+" : "-"}${Math.abs(deltaPct).toFixed(0)}% ${better ? betterWord : worseWord}`;
    return { metric, value, target_value: targetValue, delta_pct: Math.round(deltaPct * 100) / 100, better, label };
  });
  return { model_id: model.id, target_id: target.id, deltas };
}
