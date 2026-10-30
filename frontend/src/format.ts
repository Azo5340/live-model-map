import type { AIModel, Metrics, ModelStatus } from "./types";

export const STATUS: Record<ModelStatus, { color: string; label: string }> = {
  operational: { color: "#34d399", label: "Operational" },
  degraded: { color: "#fbbf24", label: "Degraded" },
  down: { color: "#f43f5e", label: "Down" },
  security_incident: { color: "#a855f7", label: "Security incident" },
  unknown: { color: "#64748b", label: "Unknown" },
};

export const statusOf = (m: AIModel): ModelStatus => m.status ?? "unknown";

/** Usage volume: live requests when a source provides them, otherwise daily downloads. */
export const volumeOf = (m: AIModel): number | null =>
  m.usage.active_requests_est ?? m.usage.download_count_24h;

export const METRIC_LABELS: Record<keyof Metrics, string> = {
  tokens_per_sec: "Speed (tok/s)",
  latency_ms: "Latency (ms)",
  cost_per_1k_tokens: "Cost / 1k tok ($)",
  context_window: "Context (tok)",
  elo_score: "ELO (LMArena)",
  availability_pct: "Availability 30 min (%)",
};

/** "3 min ago", "2 h ago"… */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function fmt(n: number | null | undefined, digits = 0): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(0)}k`;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

const PROVIDER_COLORS = ["#38bdf8", "#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#fb7185", "#60a5fa"];

export function providerColor(provider: string): string {
  let h = 0;
  for (const c of provider) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PROVIDER_COLORS[h % PROVIDER_COLORS.length];
}
