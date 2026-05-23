import type {
  SessionOptions, SemanticPage, ActionResult, AgentRunResult,
  Job, JobStatus, WorkflowRun, PageEvent, TraceEntry, PlannerResult,
  AgentPolicy, DSLWorkflow, AuditChainVerification, VaultCredentialMeta,
  EvalCase, EvalRunResult, ReplayResult,
} from "./types.js";

export class SoundBrowser {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeout: number;

  constructor(options: { apiKey?: string; baseUrl?: string; timeout?: number } = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.SOUND_BROWSER_URL ?? process.env.AGENT_BROWSER_URL ?? "http://localhost:3001").replace(/\/$/, "");
    const key = options.apiKey ?? process.env.SOUND_BROWSER_API_KEY ?? process.env.AGENT_BROWSER_API_KEY ?? "dev-key";
    this.headers = { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" };
    this.timeout = options.timeout ?? 120_000;
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  async createSession(opts: SessionOptions = {}): Promise<string> {
    const d = await this.post<{ session_id: string }>("/session", opts);
    return d.session_id;
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.delete(`/session/${sessionId}`);
  }

  async session<T>(fn: (sessionId: string) => Promise<T>, opts: SessionOptions = {}): Promise<T> {
    const sid = await this.createSession(opts);
    try { return await fn(sid); }
    finally { await this.closeSession(sid).catch(() => {}); }
  }

  // ── Navigation & Page ─────────────────────────────────────────────────────

  async navigate(sessionId: string, url: string): Promise<SemanticPage> {
    const d = await this.post<{ page: SemanticPage }>(`/session/${sessionId}/navigate`, { url });
    return d.page;
  }

  async getPage(sessionId: string, opts: { fresh?: boolean } = {}): Promise<SemanticPage> {
    const q = opts.fresh ? "?fresh=true" : "";
    const d = await this.get<{ page: SemanticPage }>(`/session/${sessionId}/page${q}`);
    return d.page;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async action(sessionId: string, action: Record<string, unknown>): Promise<ActionResult> {
    return this.post<ActionResult>(`/session/${sessionId}/action`, action);
  }

  async actions(sessionId: string, actions: Record<string, unknown>[]): Promise<{ results: ActionResult[]; page?: SemanticPage }> {
    return this.post(`/session/${sessionId}/actions`, { actions });
  }

  async js(sessionId: string, expression: string): Promise<unknown> {
    const d = await this.post<{ result: unknown }>(`/session/${sessionId}/evaluate`, { expression });
    return d.result;
  }

  async screenshot(sessionId: string): Promise<Buffer> {
    const res = await fetch(`${this.baseUrl}/session/${sessionId}/screenshot`, { headers: this.headers });
    if (!res.ok) throw new Error(`Screenshot failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  async configureAuth(sessionId: string, username: string, password: string, opts: {
    site?: string; totpSecret?: string; mfaType?: string;
    captchaKey?: string; captchaService?: string;
  } = {}): Promise<void> {
    await this.post(`/session/${sessionId}/auth/configure`, { username, password, ...opts });
  }

  async login(sessionId: string): Promise<{ success: boolean; error?: string }> {
    return this.post(`/session/${sessionId}/auth/login`, {});
  }

  async saveAuth(sessionId: string, profile: string): Promise<void> {
    await this.post(`/session/${sessionId}/auth/save`, { profile });
  }

  async loadAuth(sessionId: string, profile: string): Promise<void> {
    await this.post(`/session/${sessionId}/auth/load`, { profile });
  }

  async saveStateSnapshot(sessionId: string, profile: string): Promise<{
    status: string;
    profile: string;
    tabs_saved: number;
    cookies_saved: number;
    local_storage_keys: number;
    session_storage_keys: number;
    semantic_graph_diffs: number;
    network_events_saved: number;
  }> {
    return this.post(`/session/${sessionId}/state/save`, { profile });
  }

  async loadStateSnapshot(sessionId: string, profile: string): Promise<{
    status: string;
    profile: string;
    cookies_loaded: number;
    tabs_target: number;
    current_url?: string;
    semantic_page_loaded: boolean;
    semantic_graph_diffs: number;
    network_events_loaded: number;
  }> {
    return this.post(`/session/${sessionId}/state/load`, { profile });
  }

  async listStateSnapshots(): Promise<string[]> {
    const d = await this.get<{ profiles: string[] }>("/state/profiles");
    return d.profiles;
  }

  async deleteStateSnapshot(profile: string): Promise<{ status: string; profile: string }> {
    return this.delete(`/state/profiles/${encodeURIComponent(profile)}`) as Promise<{ status: string; profile: string }>;
  }

  // ── Intelligence ──────────────────────────────────────────────────────────

  async run(sessionId: string, goal: string, opts: {
    maxSteps?: number; provider?: string; model?: string; apiKey?: string;
  } = {}): Promise<AgentRunResult> {
    return this.post(`/session/${sessionId}/run`, {
      goal, max_steps: opts.maxSteps ?? 20, provider: opts.provider,
      model: opts.model, api_key: opts.apiKey,
    });
  }

  async plan(sessionId: string, goal: string, opts: {
    maxSubtasks?: number; provider?: string; model?: string;
  } = {}): Promise<PlannerResult> {
    return this.post(`/session/${sessionId}/plan`, {
      goal, max_subtasks: opts.maxSubtasks ?? 8, provider: opts.provider, model: opts.model,
    });
  }

  async vision(sessionId: string, intent: string): Promise<{ suggested_actions: Record<string, unknown>[] }> {
    return this.post(`/session/${sessionId}/vision`, { intent });
  }

  // ── Iframes ───────────────────────────────────────────────────────────────

  async iframeFill(sessionId: string, iframeSrc: string, selector: string, value: string): Promise<ActionResult> {
    return this.post(`/session/${sessionId}/iframe/fill`, { iframe_src: iframeSrc, selector, value });
  }

  async iframeClick(sessionId: string, iframeSrc: string, selector: string): Promise<ActionResult> {
    return this.post(`/session/${sessionId}/iframe/click`, { iframe_src: iframeSrc, selector });
  }

  async iframeEval(sessionId: string, iframeSrc: string, expression: string): Promise<unknown> {
    const d = await this.post<{ result: unknown }>(`/session/${sessionId}/iframe/eval`, { iframe_src: iframeSrc, expression });
    return d.result;
  }

  // ── Events & Tracing ──────────────────────────────────────────────────────

  async getEvents(sessionId: string, pendingOnly = false): Promise<PageEvent[]> {
    const q = pendingOnly ? "?pending=true" : "";
    const d = await this.get<{ events: PageEvent[] }>(`/session/${sessionId}/events${q}`);
    return d.events;
  }

  async startTrace(sessionId: string): Promise<void> {
    await this.post(`/session/${sessionId}/trace/start`, {});
  }

  async stopTrace(sessionId: string): Promise<void> {
    await this.post(`/session/${sessionId}/trace/stop`, {});
  }

  async getTrace(sessionId: string): Promise<TraceEntry[]> {
    const d = await this.get<{ entries: TraceEntry[] }>(`/session/${sessionId}/trace`);
    return d.entries;
  }

  async getGraphDiffs(sessionId: string, since = 0): Promise<{ diffs: unknown[]; mutation_count: number }> {
    return this.get(`/session/${sessionId}/graph/diffs?since=${since}`);
  }

  // ── Developer Platform: Eval + Replay ───────────────────────────────────

  async runEval(cases: EvalCase[]): Promise<EvalRunResult> {
    return this.post("/eval/run", { cases });
  }

  async replayActions(actions: Record<string, unknown>[], opts: {
    sessionId?: string; stopOnFailure?: boolean;
  } = {}): Promise<ReplayResult> {
    return this.post("/replay/actions", {
      actions,
      session_id: opts.sessionId,
      stop_on_failure: opts.stopOnFailure,
    });
  }

  async replayTrace(traceSessionId: string, opts: {
    sessionId?: string; stopOnFailure?: boolean;
  } = {}): Promise<ReplayResult> {
    return this.post("/replay/trace", {
      trace_session_id: traceSessionId,
      session_id: opts.sessionId,
      stop_on_failure: opts.stopOnFailure,
    });
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────

  async submitJob(goal: string, opts: {
    siteUrl?: string; type?: "run" | "plan"; maxSteps?: number;
    provider?: string; model?: string; apiKey?: string; webhookUrl?: string;
  } = {}): Promise<{ job_id: string; status: string }> {
    return this.post("/jobs", {
      goal, type: opts.type ?? "run", site_url: opts.siteUrl,
      max_steps: opts.maxSteps ?? 20, provider: opts.provider,
      model: opts.model, api_key: opts.apiKey, webhook_url: opts.webhookUrl,
    });
  }

  async getJob(jobId: string): Promise<Job> {
    return this.get(`/jobs/${jobId}`);
  }

  async listJobs(status?: JobStatus): Promise<Job[]> {
    const q = status ? `?status=${status}` : "";
    const d = await this.get<{ jobs: Job[] }>(`/jobs${q}`);
    return d.jobs;
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.delete(`/jobs/${jobId}`);
  }

  async resolveHITL(jobId: string, resolution: string): Promise<void> {
    await this.post(`/jobs/${jobId}/resolve`, { resolution });
  }

  /** Poll job until done. Resolves with the completed job. */
  async waitForJob(jobId: string, opts: { pollMs?: number; timeoutMs?: number } = {}): Promise<Job> {
    const poll = opts.pollMs ?? 2000;
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60 * 1000);
    while (Date.now() < deadline) {
      const job = await this.getJob(jobId);
      if (["done", "failed", "cancelled"].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, poll));
    }
    throw new Error(`Job ${jobId} did not complete within timeout`);
  }

  // ── Layer 2: API Replay ───────────────────────────────────────────────────

  async startRecording(siteUrl: string, orgId = "default"): Promise<{ recording_id: string; message: string }> {
    return this.post("/record/start", { site_url: siteUrl, org_id: orgId });
  }

  async stopRecording(siteUrl: string, workflowName: string, orgId = "default"): Promise<{ workflow_name: string; endpoints_captured: number; graph_version: number }> {
    return this.post("/record/stop", { site_url: siteUrl, workflow_name: workflowName, org_id: orgId });
  }

  async do(site: string, intent: string, opts: {
    orgId?: string; authToken?: string; cookies?: Record<string, string>; llmProvider?: string;
  } = {}): Promise<{ success: boolean; steps: unknown[]; error?: string }> {
    return this.post("/do", {
      site, intent, org_id: opts.orgId ?? "default",
      auth_token: opts.authToken, cookies: opts.cookies, llm_provider: opts.llmProvider,
    });
  }

  // ── Workflows ─────────────────────────────────────────────────────────────

  async listWorkflows(): Promise<Array<{ id: string; name: string; site: string; nodes: number }>> {
    const d = await this.get<{ workflows: Array<{ id: string; name: string; site: string; nodes: number }> }>("/workflows");
    return d.workflows;
  }

  async runWorkflow(sessionId: string, workflowId: string, resumeFrom?: string): Promise<WorkflowRun> {
    return this.post(`/session/${sessionId}/workflow/run`, { workflow_id: workflowId, resume_from: resumeFrom });
  }

  // ── Memory ────────────────────────────────────────────────────────────────

  async listMemories(): Promise<Array<{ site_host: string; visit_count: number; corrections: number }>> {
    const d = await this.get<{ memories: Array<{ site_host: string; visit_count: number; corrections: number }> }>("/memory");
    return d.memories;
  }

  async listSemanticCache(): Promise<Array<{ url: string; cached_at: number; hits: number }>> {
    const d = await this.get<{ entries: Array<{ url: string; cached_at: number; hits: number }> }>("/semantic-cache");
    return d.entries;
  }

  async clearSemanticCache(url?: string): Promise<{ status: string; removed: number; scope: "url" | "all" }> {
    const q = url ? `?url=${encodeURIComponent(url)}` : "";
    return this.delete(`/semantic-cache${q}`) as Promise<{ status: string; removed: number; scope: "url" | "all" }>;
  }

  // ── Pool ──────────────────────────────────────────────────────────────────

  // ── Skills ───────────────────────────────────────────────────────────────

  async listSkills(site?: string): Promise<Array<{ name: string; description: string; site: string; reliability?: number }>> {
    const q = site ? `?site=${encodeURIComponent(site)}` : "";
    const d = await this.get<{ skills: any[] }>(`/skills${q}`);
    return d.skills;
  }

  async runSkill(sessionId: string, skillName: string, params: Record<string, string> = {}): Promise<{ success: boolean; skill: string; results: unknown[] }> {
    return this.post(`/skills/${encodeURIComponent(skillName)}/run`, { session_id: sessionId, params });
  }

  // ── Audit Logs ────────────────────────────────────────────────────────────

  async getAuditLog(orgId: string, opts: { date?: string; sessionId?: string; severity?: string; limit?: number } = {}): Promise<{ entries: unknown[]; count: number }> {
    const params = new URLSearchParams();
    if (opts.date) params.set("date", opts.date);
    if (opts.sessionId) params.set("session_id", opts.sessionId);
    if (opts.severity) params.set("severity", opts.severity);
    if (opts.limit) params.set("limit", String(opts.limit));
    const q = params.toString() ? `?${params}` : "";
    return this.get(`/audit/${orgId}${q}`);
  }

  async verifyAuditLog(orgId: string, date?: string): Promise<AuditChainVerification> {
    const q = date ? `?date=${encodeURIComponent(date)}` : "";
    return this.get(`/audit/${orgId}/verify${q}`);
  }

  async exportAuditLog(orgId: string, opts: { format?: "jsonl" | "csv"; date?: string; sessionId?: string; severity?: string; limit?: number } = {}): Promise<string> {
    const params = new URLSearchParams();
    if (opts.format) params.set("format", opts.format);
    if (opts.date) params.set("date", opts.date);
    if (opts.sessionId) params.set("session_id", opts.sessionId);
    if (opts.severity) params.set("severity", opts.severity);
    if (opts.limit) params.set("limit", String(opts.limit));
    const q = params.toString() ? `?${params}` : "";
    const res = await fetch(`${this.baseUrl}/audit/${encodeURIComponent(orgId)}/export${q}`, {
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`GET /audit/${orgId}/export failed ${res.status}: ${err}`);
    }
    return res.text();
  }

  async listVaultCredentials(orgId: string, userId?: string): Promise<VaultCredentialMeta[]> {
    const q = userId ? `?user_id=${encodeURIComponent(userId)}` : "";
    const d = await this.get<{ credentials: VaultCredentialMeta[] }>(`/vault/${encodeURIComponent(orgId)}${q}`);
    return d.credentials;
  }

  async setVaultCredential(orgId: string, payload: {
    site: string;
    username?: string;
    password?: string;
    totp_secret?: string;
    api_key?: string;
    user_id?: string;
  }): Promise<{ status: string; site: string; user_id: string }> {
    return this.post(`/vault/${encodeURIComponent(orgId)}`, payload);
  }

  async getVaultCredential(orgId: string, site: string, userId?: string): Promise<{
    site: string;
    username?: string;
    has_password: boolean;
    has_api_key: boolean;
    totp_code?: string;
    user_id: string;
    updated_at: string;
  }> {
    const q = userId ? `?user_id=${encodeURIComponent(userId)}` : "";
    return this.get(`/vault/${encodeURIComponent(orgId)}/${encodeURIComponent(site)}${q}`);
  }

  async deleteVaultCredential(orgId: string, site: string, userId?: string): Promise<{ status: string }> {
    const q = userId ? `?user_id=${encodeURIComponent(userId)}` : "";
    return this.delete(`/vault/${encodeURIComponent(orgId)}/${encodeURIComponent(site)}${q}`) as Promise<{ status: string }>;
  }

  // ── Cross-Page Context ────────────────────────────────────────────────────

  async getContext(sessionId: string): Promise<{ current: unknown; history: unknown[]; breadcrumb: string[]; summary: string }> {
    return this.get(`/session/${sessionId}/context`);
  }

  async poolStats(): Promise<{ total: number; active: number; idle: number; queued: number; max: number }> {
    return this.get("/pool");
  }

  // ── RBAC / Policies ──────────────────────────────────────────────────────

  async listPolicies(orgId: string): Promise<unknown[]> {
    const d = await this.get<{ policies: unknown[] }>(`/policies/${orgId}`);
    return d.policies;
  }

  async createPolicy(orgId: string, policy: {
    agent_id: string; preset?: string; allow?: string[]; deny?: string[];
    allowed_sites?: string[]; denied_sites?: string[]; display_name?: string;
  }): Promise<unknown> {
    return this.post(`/policies/${orgId}`, policy);
  }

  async getPolicy(orgId: string, agentId: string): Promise<unknown> {
    return this.get(`/policies/${orgId}/${agentId}`);
  }

  async checkAgentPermission(orgId: string, agentId: string, permission: string, site?: string): Promise<{ allowed: boolean; permission_check: unknown; rate_limit_check: unknown }> {
    return this.post(`/policies/${orgId}/${agentId}/check`, { permission, site });
  }

  // ── Declarative Workflow DSL ──────────────────────────────────────────────

  async listDSLWorkflows(): Promise<Array<{ name: string; site: string; path: string }>> {
    const d = await this.get<{ workflows: Array<{ name: string; site: string; path: string }> }>("/dsl");
    return d.workflows;
  }

  async uploadDSL(content: string): Promise<{ status: string; name: string; site: string; steps: number }> {
    const res = await fetch(`${this.baseUrl}/dsl`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "text/plain" },
      body: content,
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`POST /dsl failed ${res.status}: ${err}`);
    }
    return res.json();
  }

  async compileDSL(name: string, params: Record<string, string> = {}): Promise<{ status: string; graph_id: string; name: string }> {
    return this.post(`/dsl/${encodeURIComponent(name)}/compile`, params);
  }

  async runDSL(sessionId: string, opts: { content?: string; name?: string; params?: Record<string, string> }): Promise<unknown> {
    return this.post("/dsl/run", { session_id: sessionId, ...opts });
  }

  // ── Health ────────────────────────────────────────────────────────────────

  async health(): Promise<{ status: string; service: string; version: string }> {
    const res = await fetch(`${this.baseUrl}/health`);
    return res.json();
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`POST ${path} failed ${res.status}: ${err}`);
    }
    return res.json();
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) throw new Error(`GET ${path} failed ${res.status}`);
    return res.json();
  }

  private async delete(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, { method: "DELETE", headers: this.headers });
    if (!res.ok) throw new Error(`DELETE ${path} failed ${res.status}`);
    return res.json().catch(() => null);
  }
}

export const AgentBrowser = SoundBrowser;
