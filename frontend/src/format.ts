import type { AIModel, Metrics, ModelStatus } from "./types";

export const STATUS: Record<ModelStatus, { color: string; label: string }> = {
  operational: { color: "#34d399", label: "Fonctionne" },
  degraded: { color: "#fbbf24", label: "Dégradé" },
  down: { color: "#f43f5e", label: "En panne" },
  security_incident: { color: "#a855f7", label: "Faille de sécurité" },
  unknown: { color: "#64748b", label: "État inconnu" },
};

export const statusOf = (m: AIModel): ModelStatus => m.status ?? "unknown";

/** Node scale from usage volume, on a log scale so a few huge models don't flatten the rest. */
export const MIN_SCALE = 0.8;
export const MAX_SCALE = 1.7;
export function volumeScale(volume: number | null, maxVolume: number): number {
  if (!volume || maxVolume <= 0) return MIN_SCALE;
  const t = Math.log10(1 + volume) / Math.log10(1 + maxVolume);
  return MIN_SCALE + (MAX_SCALE - MIN_SCALE) * t;
}

/** Usage volume: live requests when a source provides them, otherwise daily downloads. */
export const volumeOf = (m: AIModel): number | null =>
  m.usage.active_requests_est ?? m.usage.download_count_24h;

export const METRIC_LABELS: Record<keyof Metrics, string> = {
  tokens_per_sec: "Vitesse (tok/s)",
  latency_ms: "Latence (ms)",
  cost_per_1k_tokens: "Coût / 1k tok ($)",
  context_window: "Contexte (tok)",
  elo_score: "ELO (LMArena)",
  availability_pct: "Disponibilité 30 min (%)",
};

/** "il y a 3 min", "il y a 2 h"… */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}

export function fmt(n: number | null | undefined, digits = 0): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(0)}k`;
  return n.toLocaleString("fr-FR", { maximumFractionDigits: digits });
}

const PROVIDER_COLORS = ["#38bdf8", "#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#fb7185", "#60a5fa"];

export function providerColor(provider: string): string {
  let h = 0;
  for (const c of provider) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PROVIDER_COLORS[h % PROVIDER_COLORS.length];
}
