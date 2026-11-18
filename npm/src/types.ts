export interface Action { name: string; description: string; url: string; auto_approve: boolean }
export type ToolEffect = "read" | "sandbox" | "privileged";
export interface RegisteredTool {
  name: string;
  description: string;
  input_schema: unknown;
  adapter: string;
  effect: ToolEffect;
  auto_approve?: boolean;
  options?: unknown;
}
export interface Monitor {
  id: string;
  health_url: string;
  expected_status: number;
  interval_seconds: number;
  timeout_seconds: number;
  environment: "test" | "staging" | "production";
  diagnostics: { name: string; url: string }[];
  actions: Action[];
  tools?: RegisteredTool[];
}
export interface Config {
  provider: { kind: "anthropic" | "openai_compatible"; base_url: string; model: string; max_output_tokens: number };
  limits: {
    daily_budget_microusd: number;
    reserve_per_request_microusd: number;
    daily_requests: number;
    requests_per_incident: number;
    daily_actions: number;
    investigation_timeout_seconds: number;
  };
  monitors: Monitor[];
}
export interface Call { id: string; name: string; arguments: unknown }
export interface Accepted { session: unknown; reply: { text: string; calls: Call[] } }
export type IncidentState = "queued" | "investigating" | "awaiting_approval" | "needs_attention" | "resolved";
export interface Incident {
  id: string;
  monitor: string;
  state: IncidentState;
  pending_action: string | null;
  approved_action: string | null;
  attempted: number;
  requests: number;
  config: string;
  created_at: number;
}
export interface History { kind: string; detail: string; at: number }

interface SignalBase { id: string; service: string; name: string; timestamp: number; properties?: Record<string, string | number | boolean | null> }
export type Signal = SignalBase & (
  | { kind: "event"; distinct_id: string }
  | { kind: "log"; level: "trace" | "debug" | "info" | "warn" | "error" | "fatal"; message: string; trace_id?: string | null }
  | { kind: "span"; trace_id: string; span_id: string; parent_span_id?: string | null; duration_ms: number; status: "ok" | "error" | "unset" }
  | { kind: "metric"; metric_type: "gauge"; value: number; unit: string }
);
