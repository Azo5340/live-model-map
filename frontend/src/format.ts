import type { AIModel, Metrics, ModelEval, ModelStatus } from "./types";

/**
 * "Darkroom" palette: warm near-black, a golden core, and one soft hue per model family.
 */
export const THEME = {
  background: "#0E0A09",
  panel: "#161110",
  line: "#2A211D",
  text: "#F3EAE0",
  muted: "#A7968A",
  accent: "#E9A25F",
} as const;

/** The core and the light that flows into it. */
export const GOLD = "#F2B861";

/** One hue per provider family (by download rank): soft, slightly desaturated, warm-friendly. */
export const FAMILY = [
  "#7CC6A4", // jade
  "#A99BE6", // lavender
  "#E9A25F", // amber
  "#6FA6DE", // azure
  "#E8DCCB", // ivory
  "#E27D68", // coral
  "#D58DB5", // rose
  "#6FC2C0", // teal
  "#C9C27A", // olive gold
] as const;

// Statuses no longer colour the map; they show as a ring only where something needs attention.
export const STATUS: Record<ModelStatus, { color: string; label: string }> = {
  operational: { color: "#7CC6A4", label: "Operational" },
  degraded: { color: "#E8B04A", label: "Degraded" },
  down: { color: "#E5624E", label: "Down" },
  security_incident: { color: "#D978B5", label: "Security incident" },
  unknown: { color: "#8C7E76", label: "Unknown" },
};

/** Statuses that get a ring on the map. */
export const ALERT_STATUSES: ModelStatus[] = ["degraded", "down", "security_incident"];

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

const PROVIDER_COLORS = [...FAMILY];

export function providerColor(provider: string): string {
  let h = 0;
  for (const c of provider) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PROVIDER_COLORS[h % PROVIDER_COLORS.length];
}
