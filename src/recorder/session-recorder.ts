import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { normalizeUrlTemplate, extractQueryParams } from "./url-normalizer.ts";
import type {
  CapturedRequest,
  Endpoint,
  EndpointParam,
  OutputExtractor,
  ParamBinding,
  RecordedWorkflow,
  RecordingSession,
} from "./types.ts";

const SKIP_EXTENSIONS = new Set([
  ".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".eot", ".map", ".webp", ".avif",
]);

const SKIP_METHODS = new Set(["GET"]); // only capture state-mutating calls by default

function shouldCapture(url: string, method: string): boolean {
  try {
    const parsed = new URL(url);
    const ext = parsed.pathname.split(".").pop()?.toLowerCase() ?? "";
    if (SKIP_EXTENSIONS.has(`.${ext}`)) return false;
    // Always capture non-GET
    if (!SKIP_METHODS.has(method.toUpperCase())) return true;
    // Capture GET only if path looks like an API endpoint (has /api/ or accepts JSON)
    return parsed.pathname.includes("/api/") || parsed.pathname.includes("/v1/") ||
      parsed.pathname.includes("/v2/") || parsed.pathname.includes("/graphql");
  } catch {
    return false;
  }
}

function detectAuthType(
  headers: Record<string, string>,
): Endpoint["auth_type"] {
  const auth = headers["authorization"]?.toLowerCase() ?? "";
  const cookie = headers["cookie"] ?? "";
  if (auth.startsWith("bearer ")) return "bearer";
  if (auth.startsWith("basic ")) return "basic";
  if (cookie.length > 0) return "cookie";
  return "none";
}

function inferParamsFromBody(body: unknown): EndpointParam[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.keys(body as Record<string, unknown>).map((key) => ({
    name: key,
    type: inferType((body as Record<string, unknown>)[key]),
    required: true,
    source: "body" as const,
  }));
}

function inferType(value: unknown): EndpointParam["type"] {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  return "object";
}

function inferOutputExtractors(
  responseBody: unknown,
  _endpointMethod: string,
): OutputExtractor[] {
  if (!responseBody || typeof responseBody !== "object") return [];
  const extractors: OutputExtractor[] = [];

  function scan(obj: Record<string, unknown>, prefix: string) {
    for (const [key, val] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : `$.${key}`;
      if (
        typeof val === "string" &&
        (key.endsWith("_id") || key === "id" || key.endsWith("Id"))
      ) {
        extractors.push({ field: key, jsonpath: path });
      } else if (val && typeof val === "object" && !Array.isArray(val)) {
        scan(val as Record<string, unknown>, path);
      }
    }
  }

  scan(responseBody as Record<string, unknown>, "");
  return extractors;
}

// Detect param_bindings by matching extractor field names to subsequent endpoint params
function inferParamBindings(
  capturedRequests: CapturedRequest[],
  endpoints: Endpoint[],
): void {
  // Build a map: extractor field → url_template that produced it
  const extractorMap = new Map<string, string>(); // field → url_template
  for (const ep of endpoints) {
    for (const ex of ep.output_extractors) {
      extractorMap.set(ex.field, ep.url_template);
    }
  }

  // For each endpoint, check if any of its params match a known extractor field
  for (const req of capturedRequests) {
    const ep = endpoints.find((e) => e.url_template === req.url_template);
    if (!ep) continue;

    for (const param of ep.params) {
      if (extractorMap.has(param.name)) {
        const sourceTemplate = extractorMap.get(param.name)!;
        if (sourceTemplate !== ep.url_template) {
          ep.param_bindings.push({
            source_extractor: param.name,
            target_param: param.name,
            target_location: param.source,
          });
        }
      }
    }
  }
}

export class SessionRecorder {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private session: RecordingSession | null = null;
  private endpointMap = new Map<string, Endpoint>();

  async launch(siteUrl: string): Promise<void> {
    this.browser = await chromium.launch({ headless: false });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    await this.page.goto(siteUrl);
  }

  async begin_recording(): Promise<void> {
    if (!this.page || !this.context) throw new Error("Call launch() first");
    if (this.session) throw new Error("Recording already in progress");

    this.session = {
      name: "",
      site_url: this.page.url(),
      captured: [],
      started_at: new Date(),
    };
    this.endpointMap.clear();

    // Subscribe to CDP disconnect events
    this.page.on("close", () => {
      if (this.session) {
        throw new Error("RecordingInterruptedError: page closed during recording");
      }
    });
    this.context.on("close", () => {
      if (this.session) {
        throw new Error("RecordingInterruptedError: browser context closed during recording");
      }
    });

    // Intercept all network requests via Playwright route API
    await this.page.route("**/*", async (route) => {
      const request = route.request();
      const method = request.method();
      const url = request.url();

      if (!shouldCapture(url, method)) {
        await route.continue();
        return;
      }

      let requestBody: unknown = null;
      try {
        const postData = request.postData();
        if (postData) requestBody = JSON.parse(postData);
      } catch {
        requestBody = request.postData();
      }

      // Continue the request and capture the response
      const response = await route.fetch();
      await route.fulfill({ response });

      let responseBody: unknown = null;
      try {
        const text = await response.text();
        responseBody = JSON.parse(text);
      } catch {
        responseBody = null;
      }

      if (!this.session) return;

      const urlTemplate = normalizeUrlTemplate(url);
      const requestHeaders = await request.allHeaders();

      const captured: CapturedRequest = {
        method,
        url,
        url_template: urlTemplate,
        request_headers: requestHeaders,
        request_body: requestBody,
        response_status: response.status(),
        response_body: responseBody,
        response_headers: Object.fromEntries(
          Object.entries(response.headers()),
        ),
        timestamp: Date.now(),
      };

      this.session.captured.push(captured);

      // Build/update endpoint schema
      const epKey = `${method}:${urlTemplate}`;
      if (!this.endpointMap.has(epKey)) {
        const queryParams = extractQueryParams(url);
        const queryParamList: EndpointParam[] = Object.keys(queryParams).map((k) => ({
          name: k,
          type: "string" as const,
          required: false,
          source: "query" as const,
        }));
        const bodyParams = inferParamsFromBody(requestBody);
        const outputExtractors = response.status() < 300
          ? inferOutputExtractors(responseBody, method)
          : [];

        this.endpointMap.set(epKey, {
          method,
          url_template: urlTemplate,
          params: [...queryParamList, ...bodyParams],
          auth_type: detectAuthType(requestHeaders),
          prerequisite_endpoints: [],
          success_indicators: [response.status()],
          output_extractors: outputExtractors,
          param_bindings: [],
        });
      }
    });
  }

  async end_recording(name: string): Promise<RecordedWorkflow> {
    if (!this.session) throw new Error("No recording in progress. Call begin_recording() first.");
    if (!this.page) throw new Error("Page not available.");

    await this.page.unroute("**/*");

    const endpoints = Array.from(this.endpointMap.values());

    // Infer prerequisite ordering from capture sequence
    const seenTemplates: string[] = [];
    for (const req of this.session.captured) {
      const epKey = `${req.method}:${req.url_template}`;
      const ep = this.endpointMap.get(epKey);
      if (ep && !seenTemplates.includes(req.url_template)) {
        ep.prerequisite_endpoints = [...seenTemplates];
        seenTemplates.push(req.url_template);
      }
    }

    // Infer param bindings from cross-endpoint data flow
    inferParamBindings(this.session.captured, endpoints);

    const workflow: RecordedWorkflow = {
      name,
      site_url: this.session.site_url,
      endpoints,
      recorded_at: new Date(),
      sequence: seenTemplates,
    };

    this.session = null;
    return workflow;
  }

  async close(): Promise<void> {
    if (this.session) {
      throw new Error("Recording still in progress. Call end_recording() before close().");
    }
    await this.browser?.close();
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}
