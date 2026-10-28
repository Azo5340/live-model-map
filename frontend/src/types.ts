export interface Metrics {
  tokens_per_sec: number | null;
  latency_ms: number | null;
  cost_per_1k_tokens: number | null;
  context_window: number | null;
  elo_score: number | null;
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
  updated_at: string;
}

export type ModelStatus = "operational" | "degraded" | "down" | "security_incident" | "unknown";

export interface Graph {
  nodes: AIModel[];
  links: { source: string; target: string }[];
}

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
