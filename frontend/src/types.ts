export interface Metrics {
  tokens_per_sec: number | null;
  latency_ms: number | null;
  cost_per_1k_tokens: number | null;
  context_window: number | null;
  elo_score: number | null;
  /** Best OpenRouter provider's uptime over the last 30 min, in %. */
  availability_pct?: number | null;
}

export interface Usage {
  download_count_24h: number | null;
  active_requests_est: number | null;
}

export interface AIModel {
  id: string;
  name: string;
  provider: string;
  parent_model_id: string | null;
  release_date: string | null;
  metrics: Metrics;
  usage: Usage;
  status: ModelStatus | null;
  status_detail: string | null;
  security?: SecurityScan | null;
  /** LMArena (text, overall) entry this model was matched to. */
  arena?: { name: string; rating: number; rank: number | null; votes: number | null; date: string | null } | null;
  updated_at: string;
}

/** Hugging Face's scan of the model repo's files (malware, unsafe pickles). */
export interface SecurityScan {
  scanned: boolean;
  issues: { path: string; level: "unsafe" | "suspicious" }[];
  checked_at: string;
}

export type ModelStatus = "operational" | "degraded" | "down" | "security_incident" | "unknown";

export interface Graph {
  nodes: AIModel[];
  links: { source: string; target: string }[];
  /** Provider logos from Hugging Face, keyed by provider name. */
  providers?: Providers;
}

export type Providers = Record<string, { avatar: string | null; checked_at: string }>;

export type StreamEventType = "MODEL_ADDED" | "METRICS_UPDATED" | "STATUS_CHANGED" | "ALERT";

export interface StreamEvent {
  type: StreamEventType;
  ts: string;
  payload: {
    source?: string;
    model?: AIModel;
    previous_status?: ModelStatus | null;
    message?: string;
    level?: "info" | "warning" | "critical";
    model_id?: string | null;
  };
}

export interface Checkup {
  ts: string;
  duration_s: number;
  full: boolean;
  initial: boolean;
  total: number;
  checked_status: number;
  added: { id: string; name: string }[];
  added_count: number;
  status_changes: { id: string; name: string; from: ModelStatus | null; to: ModelStatus }[];
  metric_changes: number;
  errors: string[];
  error_count: number;
}

export type TodoKind = "security_incident" | "down" | "degraded" | "new_model";

export interface TodoItem {
  id: string;
  kind: TodoKind;
  title: string;
  model_id: string;
  model_name: string;
  detail: string | null;
  since: string;
}

export interface Todo {
  generated_at: string;
  items: TodoItem[];
}

export interface MetricDelta {
  metric: keyof Metrics;
  value: number | null;
  target_value: number | null;
  delta_pct: number | null;
  better: boolean | null;
  label: string;
}

export interface Comparison {
  model_id: string;
  target_id: string;
  deltas: MetricDelta[];
}

/** One score on a set of problems, with its 95 % margin of error. */
export interface EvalScore {
  k: number;
  n: number;
  lo: number;
  hi: number;
}

/** Results of the daily reasoning evaluation for one model (eval.json). */
export interface ModelEval {
  known: EvalScore | null;
  modified: EvalScore | null;
  drop: { mean: number; lo: number; hi: number } | null;
  memorises: boolean;
  truncated: number;
  claimed_gsm8k: number | null;
  quality: { value: number; lo: number | null; hi: number | null; source: "both" | "measured" | "arena" } | null;
  underrated: number | null;
  tied_with: string[];
  downloads: number;
}

export interface EvalSummary {
  generated_at: string;
  budget_usd: number;
  spent_usd: number;
  problems: number;
  scale: "arena" | "separate";
  popularity: { spearman: number; lo: number; hi: number; n: number } | null;
  headline: string | null;
  names: Record<string, string>;
  models: Record<string, ModelEval>;
}
