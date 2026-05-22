/**
 * Recorder Bridge — connects SessionRecorder → extractGraph → GraphStore.
 *
 * Manages active recording sessions (one per org+site).
 * Persists completed workflows to disk.
 */

import { SessionRecorder } from "../recorder/session-recorder.ts";
import { extractGraph } from "../graph/extractor.ts";
import { saveGraph, loadGraph } from "./graph-store.ts";
import type { RecordedWorkflow } from "../recorder/types.ts";
import type { ApiGraph } from "../graph/types.ts";

interface ActiveRecording {
  recorder: SessionRecorder;
  orgId: string;
  siteUrl: string;
  startedAt: Date;
}

const activeRecordings = new Map<string, ActiveRecording>();

function recordingKey(orgId: string, siteUrl: string): string {
  const host = new URL(siteUrl).host;
  return `${orgId}:${host}`;
}

export interface RecordingStartResult {
  recording_id: string;
  org_id: string;
  site_url: string;
  message: string;
}

export interface RecordingStopResult {
  recording_id: string;
  workflow_name: string;
  endpoints_captured: number;
  graph_version: number;
  graph: ApiGraph;
  workflow: RecordedWorkflow;
}

/** Start a new recording session. Opens a headed Playwright browser. */
export async function startRecording(
  orgId: string,
  siteUrl: string,
): Promise<RecordingStartResult> {
  const key = recordingKey(orgId, siteUrl);
  if (activeRecordings.has(key)) {
    throw new Error(`Recording already active for ${orgId}:${new URL(siteUrl).host}. Stop it first.`);
  }

  const recorder = new SessionRecorder();
  await recorder.launch(siteUrl);
  await recorder.begin_recording();

  activeRecordings.set(key, {
    recorder,
    orgId,
    siteUrl,
    startedAt: new Date(),
  });

  return {
    recording_id: key,
    org_id: orgId,
    site_url: siteUrl,
    message: "Browser opened. Perform the workflow manually, then call /record/stop.",
  };
}

/** Stop recording, extract graph, persist to disk. */
export async function stopRecording(
  orgId: string,
  siteUrl: string,
  workflowName: string,
): Promise<RecordingStopResult> {
  const key = recordingKey(orgId, siteUrl);
  const active = activeRecordings.get(key);
  if (!active) {
    throw new Error(`No active recording for ${orgId}:${new URL(siteUrl).host}`);
  }

  const workflow = await active.recorder.end_recording(workflowName);
  await active.recorder.close();
  activeRecordings.delete(key);

  // Load existing graph to merge with (incremental learning)
  const siteHost = new URL(siteUrl).host;
  const existing = (await loadGraph(orgId, siteHost)) ?? undefined;

  // Extract and merge graph
  const graph = extractGraph(workflow, orgId, existing);

  // Count existing workflow runs
  const workflowCount = (existing?.graph_version ?? 0) + 1;
  await saveGraph(graph, workflowCount);

  return {
    recording_id: key,
    workflow_name: workflowName,
    endpoints_captured: workflow.endpoints.length,
    graph_version: graph.graph_version,
    graph,
    workflow,
  };
}

/** List all active recordings. */
export function listActiveRecordings(): Array<{
  recording_id: string;
  org_id: string;
  site_url: string;
  started_at: string;
}> {
  return Array.from(activeRecordings.entries()).map(([key, r]) => ({
    recording_id: key,
    org_id: r.orgId,
    site_url: r.siteUrl,
    started_at: r.startedAt.toISOString(),
  }));
}
