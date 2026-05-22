import type { GraphNode } from "../graph/types.ts";
import type { ApiGraph } from "../graph/types.ts";
import { classifyHttpError, classifyExtractorNull } from "./error-classifier.ts";
import { getCachedSequence, setCachedSequence } from "./cache.ts";
import { evaluateJsonPath } from "./jsonpath.ts";

export interface ExecutionResult {
  success: boolean;
  steps: StepResult[];
  error?: string;
  error_class?: string;
}

export interface StepResult {
  endpoint: string;
  status: number;
  response_body: unknown;
  extracted_values: Record<string, unknown>;
  cached: boolean;
}

export interface ExecutionContext {
  org_id: string;
  auth_token?: string;
  cookies?: Record<string, string>;
  base_url: string;
  on_auth_required?: () => Promise<{ token: string } | null>;
  on_drift_detected?: (endpoint: string) => void;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeStep(
  node: GraphNode,
  params: Record<string, unknown>,
  ctx: ExecutionContext,
  maxRetries = 3,
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  let attempt = 0;

  while (attempt <= maxRetries) {
    const url = buildUrl(node, params, ctx.base_url);
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (ctx.auth_token) headers["Authorization"] = `Bearer ${ctx.auth_token}`;
    if (ctx.cookies) {
      headers["Cookie"] = Object.entries(ctx.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    }

    const bodyParams = node.params.filter((p) => p.source === "body");
    const body = bodyParams.length > 0
      ? JSON.stringify(Object.fromEntries(bodyParams.map((p) => [p.name, params[p.name]])))
      : undefined;

    const response = await fetch(url, {
      method: node.method,
      headers,
      body: node.method !== "GET" ? body : undefined,
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => { responseHeaders[k] = v; });

    let responseBody: unknown = null;
    try {
      const text = await response.text();
      responseBody = JSON.parse(text);
    } catch {
      // non-JSON response
    }

    if (response.ok) {
      return { status: response.status, body: responseBody, headers: responseHeaders };
    }

    const classified = classifyHttpError(response.status, responseHeaders);

    if (classified.class === "auth_expired") {
      if (ctx.on_auth_required) {
        const newAuth = await ctx.on_auth_required();
        if (newAuth) {
          ctx.auth_token = newAuth.token;
          attempt++;
          continue;
        }
      }
      throw new Error(classified.message);
    }

    if (classified.class === "drift") {
      ctx.on_drift_detected?.(node.url_template);
      throw new Error(classified.message);
    }

    if (classified.class === "rate_limited") {
      await sleep(classified.retryAfterMs ?? 5000);
      attempt++;
      continue;
    }

    if (classified.class === "server_error" && attempt < maxRetries) {
      await sleep(Math.pow(2, attempt) * 1000); // exponential backoff: 1s, 2s, 4s
      attempt++;
      continue;
    }

    throw new Error(classified.message);
  }

  throw new Error(`Max retries exceeded for ${node.url_template}`);
}

function buildUrl(node: GraphNode, params: Record<string, unknown>, baseUrl: string): string {
  let path = node.url_template;

  // If url_template is already a full URL, use it directly
  if (path.startsWith("http")) {
    // Replace :param with actual values from path params
    const pathParams = node.params.filter((p) => p.source === "path");
    for (const param of pathParams) {
      const value = params[param.name];
      if (value !== undefined && value !== null) {
        path = path.replace(/:param/, String(value));
      }
    }
    const queryParams = node.params.filter((p) => p.source === "query");
    if (queryParams.length > 0) {
      const qs = queryParams
        .filter((p) => params[p.name] !== undefined)
        .map((p) => `${p.name}=${encodeURIComponent(String(params[p.name]))}`)
        .join("&");
      if (qs) path += `?${qs}`;
    }
    return path;
  }

  return `${baseUrl}${path}`;
}

export type IntentResolver = (
  intent: string,
  graph: ApiGraph,
) => Promise<GraphNode[]>;

export async function executeIntent(
  intent: string,
  graph: ApiGraph,
  ctx: ExecutionContext,
  resolveIntent: IntentResolver,
): Promise<ExecutionResult> {
  // Check cache first
  let sequence = getCachedSequence(ctx.org_id, intent, graph.graph_version);
  const fromCache = sequence !== null;

  if (!sequence) {
    sequence = await resolveIntent(intent, graph);
    if (sequence.length > 0) {
      setCachedSequence(ctx.org_id, intent, graph.graph_version, sequence);
    }
  }

  if (sequence.length === 0) {
    return {
      success: false,
      steps: [],
      error: `No API sequence found for intent: "${intent}"`,
      error_class: "no_sequence",
    };
  }

  const steps: StepResult[] = [];
  const extractedValues: Record<string, unknown> = {};

  for (const node of sequence) {
    // Build params by merging extracted values from prior steps
    const params: Record<string, unknown> = { ...extractedValues };

    try {
      const { status, body } = await executeStep(node, params, ctx);

      // Apply output extractors
      const newExtracted: Record<string, unknown> = {};
      for (const extractor of node.output_extractors) {
        const value = evaluateJsonPath(body, extractor.jsonpath);
        if (value === null || value === undefined) {
          const err = classifyExtractorNull(extractor.jsonpath, extractor.field, body);
          return {
            success: false,
            steps,
            error: err.message,
            error_class: err.class,
          };
        }
        newExtracted[extractor.field] = value;
      }

      Object.assign(extractedValues, newExtracted);
      steps.push({
        endpoint: node.url_template,
        status,
        response_body: body,
        extracted_values: { ...newExtracted },
        cached: fromCache,
      });
    } catch (err) {
      return {
        success: false,
        steps,
        error: err instanceof Error ? err.message : String(err),
        error_class: "execution_error",
      };
    }
  }

  return { success: true, steps };
}
