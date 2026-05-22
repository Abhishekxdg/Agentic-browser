export type ErrorClass =
  | "auth_expired"      // 401: stop, trigger re-auth
  | "drift"             // 404: endpoint removed or renamed
  | "rate_limited"      // 429: wait for Retry-After
  | "server_error"      // 5xx: retry with backoff
  | "client_error"      // 4xx (other): bad params, don't retry
  | "extractor_null"    // JSONPath returned null/undefined
  | "unknown";

export interface ClassifiedError {
  class: ErrorClass;
  status?: number;
  message: string;
  retryable: boolean;
  retryAfterMs?: number; // for rate_limited
}

export function classifyHttpError(
  status: number,
  responseHeaders: Record<string, string>,
): ClassifiedError {
  if (status === 401) {
    return { class: "auth_expired", status, message: "Auth token expired — re-authentication required", retryable: false };
  }
  if (status === 404) {
    return { class: "drift", status, message: "Endpoint not found — API may have changed. Re-record this workflow.", retryable: false };
  }
  if (status === 429) {
    const retryAfter = responseHeaders["retry-after"];
    const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
    return { class: "rate_limited", status, message: "Rate limited by target site", retryable: true, retryAfterMs };
  }
  if (status >= 500) {
    return { class: "server_error", status, message: `Server error ${status}`, retryable: true };
  }
  if (status >= 400) {
    return { class: "client_error", status, message: `Client error ${status} — check endpoint params`, retryable: false };
  }
  return { class: "unknown", status, message: `Unexpected status ${status}`, retryable: false };
}

export function classifyExtractorNull(jsonpath: string, field: string, responseBody: unknown): ClassifiedError {
  return {
    class: "extractor_null",
    message: `ExtractorDriftError: JSONPath "${jsonpath}" for field "${field}" returned null. Response body: ${JSON.stringify(responseBody)?.slice(0, 500)}`,
    retryable: false,
  };
}
