import type { AIModel, Metrics, ModelEval, ModelStatus } from "./types";

/**
 * "Observatory log" palette: green-black ink, bone text, aged brass for anything you can
 * interact with, verdigris for healthy instruments, steel for structure.
 */
export const THEME = {
  background: "#0B1112",
  panel: "#111A1B",
  line: "#223031",
  text: "#E7E2D4",
  muted: "#959E99",
  brass: "#C8A15A",
  verdigris: "#5FA191",
  steel: "#6F8C9B",
} as const;

// Muted, earthy states: verdigris when healthy, neutral slate when nothing is known,
// warm tones only where something needs attention.
export const STATUS: Record<ModelStatus, { color: string; label: string }> = {
  operational: { color: THEME.verdigris, label: "Operational" },
  degraded: { color: "#D4A24C", label: "Degraded" },
  down: { color: "#C75B47", label: "Down" },
  security_incident: { color: "#C96B92", label: "Security incident" },
  unknown: { color: "#6E7A7D", label: "Unknown" },
};

/** Quality view: models without a quality score, and the two badges. */
export const NO_DATA = "#7c8598";
export const BADGE = { underrated: "#F4EFE0", memorises: "#D4A24C" } as const;

/**
 * Quality colour scale: rises in lightness (deep blue-grey → sea green → pale lime), so weaker and
 * stronger stay apart even in greyscale, and uses none of the status colours.
 */
export const QUALITY_RAMP = ["#2d4b5f", "#7fa3b8", "#efe7c9"] as const;

export function qualityColor(value: number, min: number, max: number): string {
  const t = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0.5;
  const seg = t < 0.5 ? 0 : 1;
  const local = seg === 0 ? t * 2 : (t - 0.5) * 2;
  const from = parseInt(QUALITY_RAMP[seg].slice(1), 16);
  const to = parseInt(QUALITY_RAMP[seg + 1].slice(1), 16);
  const mix = (shift: number) => Math.round(((from >> shift) & 255) * (1 - local) + ((to >> shift) & 255) * local);
  return `#${[16, 8, 0].map((s) => mix(s).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * "Underrated" means clearly above what downloads predict: at least one standard deviation of
 * the gaps across all scored models. Shared by the map badge and the model panel.
 */
export function underratedThreshold(models: Record<string, ModelEval>): number {
  const gaps = Object.values(models).flatMap((e) => (e.underrated == null ? [] : [e.underrated]));
  const sd = Math.sqrt(gaps.reduce((a, g) => a + g * g, 0) / Math.max(1, gaps.length));
  return sd > 0 ? sd : Infinity;
}

export const isUnderrated = (e: ModelEval | undefined, threshold: number): boolean =>
  !!e?.quality && e.underrated != null && e.underrated >= threshold;

/** 0.893 → "89%". */
export const pct = (x: number) => `${Math.round(100 * x)}%`;

export const statusOf = (m: AIModel): ModelStatus => m.status ?? "unknown";

/** Usage volume: live requests when a source provides them, otherwise daily downloads. */
export const volumeOf = (m: AIModel): number | null =>
  m.usage.active_requests_est ?? m.usage.download_count_24h;

export const METRIC_LABELS: Record<keyof Metrics, string> = {
  tokens_per_sec: "Speed (tok/s)",
  latency_ms: "Latency (ms)",
  cost_per_1k_tokens: "Cost / 1k tok ($)",
  context_window: "Context (tok)",
  elo_score: "Elo (LMArena)",
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

const PROVIDER_COLORS = ["#C8A15A", "#5FA191", "#7FA3B8", "#B98A6E", "#A3A27A", "#8E86A8", "#6FA0A0"];

export function providerColor(provider: string): string {
  let h = 0;
  for (const c of provider) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PROVIDER_COLORS[h % PROVIDER_COLORS.length];
}
