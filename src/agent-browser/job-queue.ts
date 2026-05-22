/**
 * Async Job Queue — submit long-running agent tasks, poll for results.
 * POST /jobs → {job_id}  →  GET /jobs/:id → {status, result}
 * Persists jobs to ~/.agent-browser/jobs/ for crash recovery.
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "fs";
import { readdirSync } from "fs";
import type { AgentRunResult } from "./agent-loop.ts";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "waiting_hitl";

export interface Job {
  id: string;
  type: "run" | "do";
  status: JobStatus;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  // Input
  goal?: string;
  site?: string;
  intent?: string;
  session_id?: string;
  config?: Record<string, unknown>;
  // Output
  result?: AgentRunResult | Record<string, unknown>;
  error?: string;
  // HITL
  hitl_reason?: string;
  hitl_context?: Record<string, unknown>;
  hitl_resolved_at?: string;
  hitl_resolution?: string;
  // Webhook
  webhook_url?: string;
}

const JOBS_DIR = join(homedir(), ".agent-browser", "jobs");
const JOB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const _writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const jobs = new Map<string, Job>();
const jobResolvers = new Map<string, () => void>(); // HITL: resolve when human responds

function ensureDir() {
  if (!existsSync(JOBS_DIR)) mkdirSync(JOBS_DIR, { recursive: true });
}

function assertJobId(id: string): string {
  if (!/^job_[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid job id");
  return id;
}

function jobPath(id: string) { return join(JOBS_DIR, `${assertJobId(id)}.json`); }

function persistJob(job: Job) {
  // Debounce rapid consecutive writes for the same job (e.g. multiple updateJob calls)
  const existing = _writeTimers.get(job.id);
  if (existing) clearTimeout(existing);
  _writeTimers.set(job.id, setTimeout(() => {
    _writeTimers.delete(job.id);
    ensureDir();
    writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2), "utf8");
  }, 100));
}

function makeId() { return `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }

function loadPersistedJobs() {
  ensureDir();
  const now = Date.now();
  for (const file of readdirSync(JOBS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const job = JSON.parse(readFileSync(join(JOBS_DIR, file), "utf8")) as Job;
      if (!job.id || !job.status) continue;
      // Prune jobs older than 7 days
      const age = now - new Date(job.created_at).getTime();
      if (age > JOB_MAX_AGE_MS && (job.status === "done" || job.status === "failed" || job.status === "cancelled")) {
        try { require("fs").unlinkSync(jobPath(job.id)); } catch {}
        continue;
      }
      if (job.status === "queued" || job.status === "running" || job.status === "waiting_hitl") {
        job.status = "failed";
        job.finished_at = new Date().toISOString();
        job.error = job.error ?? "Server restarted before job finished";
        writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2), "utf8");
      }
      jobs.set(job.id, job);
    } catch { /* ignore corrupt */ }
  }
}

loadPersistedJobs();

export function createJob(fields: Omit<Job, "id" | "status" | "created_at">): Job {
  const job: Job = { id: makeId(), status: "queued", created_at: new Date().toISOString(), ...fields };
  jobs.set(job.id, job);
  persistJob(job);
  return job;
}

export function getJob(id: string): Job | null { return jobs.get(id) ?? null; }

export function updateJob(id: string, patch: Partial<Job>): Job | null {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  persistJob(job);
  return job;
}

export function listJobs(status?: JobStatus): Job[] {
  const all = Array.from(jobs.values());
  return status ? all.filter((j) => j.status === status) : all;
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status === "done" || job.status === "failed") return false;
  updateJob(id, { status: "cancelled", finished_at: new Date().toISOString() });
  return true;
}

/** Pause execution for HITL — returns a promise that resolves when human responds */
export async function waitForHuman(
  jobId: string,
  reason: string,
  context: Record<string, unknown>,
  timeoutMs = 30 * 60 * 1000, // 30 min default
): Promise<string | null> {
  updateJob(jobId, { status: "waiting_hitl", hitl_reason: reason, hitl_context: context });

  // Fire webhook if configured
  const job = jobs.get(jobId)!;
  if (job.webhook_url) {
    fetch(job.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "hitl_required", job_id: jobId, reason, context }),
    }).catch(() => {});
  }

  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      jobResolvers.delete(jobId);
      updateJob(jobId, { status: "failed", error: `HITL timeout after ${timeoutMs / 1000}s`, finished_at: new Date().toISOString() });
      resolve(null);
    }, timeoutMs);

    jobResolvers.set(jobId, () => {
      clearTimeout(timer);
      const updated = jobs.get(jobId);
      resolve(updated?.hitl_resolution ?? null);
    });
  });
}

/** Human submits resolution to a waiting job */
export function resolveHITL(jobId: string, resolution: string): boolean {
  const job = jobs.get(jobId);
  if (!job || job.status !== "waiting_hitl") return false;
  updateJob(jobId, {
    hitl_resolution: resolution,
    hitl_resolved_at: new Date().toISOString(),
    status: "running",
  });
  const resolver = jobResolvers.get(jobId);
  if (resolver) { jobResolvers.delete(jobId); resolver(); }
  return true;
}
