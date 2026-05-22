export interface SessionOptions {
  headless?: boolean;
  proxy?: string;
}

export interface SemanticField {
  name: string;
  type: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
  value?: string | number | boolean;
  options?: string[];
}

export interface SemanticButton {
  name: string;
  type: "submit" | "button" | "reset";
  label: string;
  action?: string;
}

export interface SemanticForm {
  id: string;
  purpose?: string;
  action?: string;
  method?: string;
  fields: SemanticField[];
  actions: SemanticButton[];
}

export interface SemanticLink {
  text: string;
  href: string;
  type: "link" | "button-link";
  external?: boolean;
}

export interface SemanticContentBlock {
  type: "heading" | "paragraph" | "blockquote" | "code" | "preformatted";
  level?: number;
  text: string;
}

export interface SemanticInteractive {
  id: string;
  type: "button" | "toggle" | "tab" | "accordion" | "dropdown" | "slider" | "date-picker";
  label: string;
  state?: "on" | "off" | "open" | "closed";
}

export interface SemanticTable {
  id: string;
  caption?: string;
  headers: string[];
  rows: string[][];
}

export interface SemanticDialog {
  type: "modal" | "alert" | "confirm" | "prompt" | "drawer" | "tooltip";
  title?: string;
  message?: string;
  actions: string[];
}

export interface SemanticPage {
  page: { url: string; title: string; viewport: { width: number; height: number } };
  forms: SemanticForm[];
  navigation: SemanticLink[];
  content: SemanticContentBlock[];
  interactive: SemanticInteractive[];
  tables: SemanticTable[];
  dialogs: SemanticDialog[];
  search: { fieldName: string; placeholder?: string; hasSubmit: boolean } | null;
}

export interface ActionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  confidence?: number;
  strategy?: string;
  verification?: { verified: boolean; evidence: string; confidence: number };
  page?: SemanticPage;
}

export interface AgentStep {
  step: number;
  observation: string;
  thought: string;
  action: Record<string, unknown> | null;
  result: "success" | "failed" | "done";
  error?: string;
  page_url?: string;
}

export interface AgentRunResult {
  success: boolean;
  goal: string;
  steps: AgentStep[];
  final_answer?: string;
  total_steps: number;
  error?: string;
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "waiting_hitl";

export interface Job {
  id: string;
  type: "run" | "do";
  status: JobStatus;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  goal?: string;
  result?: AgentRunResult | Record<string, unknown>;
  error?: string;
  hitl_reason?: string;
  hitl_context?: Record<string, unknown>;
}

export interface WorkflowRun {
  id: string;
  graph_id: string;
  status: "running" | "done" | "failed" | "paused";
  node_statuses: Record<string, "pending" | "running" | "done" | "failed" | "skipped">;
  node_results: Record<string, { success: boolean; error?: string; retries: number }>;
  started_at: string;
  finished_at?: string;
  error?: string;
}

export interface PageEvent {
  type: string;
  timestamp: number;
  url?: string;
  data?: Record<string, unknown>;
  requires_action?: boolean;
  suggested_action?: string;
}

export interface TraceEntry {
  session_id: string;
  step: number;
  timestamp: string;
  elapsed_ms: number;
  action: Record<string, unknown>;
  result: ActionResult;
  verification?: { verified: boolean; evidence: string };
  page_before?: { url: string; title: string };
  page_after?: { url: string; title: string };
}

export interface PlannerResult {
  success: boolean;
  goal: string;
  plan: Array<{ id: string; label: string; description: string; expected_outcome: string }>;
  completed: number;
  total: number;
  steps: AgentStep[];
  error?: string;
}

export type Permission =
  | "navigate" | "read_page" | "click" | "fill" | "submit"
  | "evaluate_js" | "run_skill" | "use_vault" | "configure_auth"
  | "run_agent" | "manage_jobs" | "read_audit" | "*";

export interface AgentPolicy {
  agent_id: string;
  org_id: string;
  display_name?: string;
  allow: Permission[];
  deny: Permission[];
  allowed_sites?: string[];
  denied_sites?: string[];
  max_sessions?: number;
  rate_limit?: { requests_per_minute: number };
  created_at: string;
  created_by?: string;
}

export interface DSLParameter {
  name: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  default?: string;
  description?: string;
}

export interface DSLStep {
  id: string;
  type: "navigate" | "fill" | "click" | "press" | "wait" | "screenshot" |
        "evaluate_js" | "verify" | "branch" | "skill" | "loop";
  description?: string;
  depends_on?: string[];
  retry?: number;
  optional?: boolean;
  checkpoint?: boolean;
  url?: string;
  form?: string;
  field?: string;
  value?: string;
  selector?: string;
  target?: string;
  text?: string;
  key?: string;
  condition?: string;
  ms?: number;
  expression?: string;
  assert?: string;
  if_condition?: string;
  if_true?: string;
  if_false?: string;
  skill?: string;
  params?: Record<string, string>;
  over?: string;
  item_var?: string;
  steps?: DSLStep[];
}

export interface DSLWorkflow {
  name: string;
  site: string;
  version?: number;
  description?: string;
  parameters?: DSLParameter[];
  steps: DSLStep[];
}
