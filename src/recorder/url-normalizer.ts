// UUID v4: 8-4-4-4-12 hex groups
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// MongoDB ObjectId: exactly 24 hex chars
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

// Purely numeric IDs (no letters) — min 1 digit
const NUMERIC_ID_RE = /^\d+$/;

// Stripe-style prefixed IDs: prefix_lowercase + alphanumeric suffix (min 8 chars total)
// e.g. inv_1234abc, cus_abcd1234, pi_3QxABC
const PREFIXED_ID_RE = /^[a-z]{1,6}_[a-zA-Z0-9]{8,}$/;

const SEMANTIC_SEGMENTS = new Set([
  "v1", "v2", "v3", "v4", "api", "admin", "public", "private",
  "users", "user", "accounts", "account", "orgs", "org",
  "create", "update", "delete", "list", "get", "submit", "cancel",
  "invoices", "invoice", "orders", "order", "payments", "payment",
  "sessions", "session", "tokens", "token", "webhooks", "webhook",
  "true", "false", "null",
]);

function isIdSegment(segment: string): boolean {
  if (SEMANTIC_SEGMENTS.has(segment.toLowerCase())) return false;
  if (UUID_RE.test(segment)) return true;
  UUID_RE.lastIndex = 0;
  if (OBJECT_ID_RE.test(segment)) return true;
  if (NUMERIC_ID_RE.test(segment)) return true;
  if (PREFIXED_ID_RE.test(segment)) return true;
  return false;
}

export function normalizeUrlTemplate(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").map((seg) => {
      if (seg === "") return seg;
      return isIdSegment(seg) ? ":param" : seg;
    });
    parsed.pathname = segments.join("/");
    // Strip query params — they're captured in EndpointParam, not the template
    parsed.search = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

export function extractQueryParams(url: string): Record<string, string> {
  try {
    const parsed = new URL(url);
    const params: Record<string, string> = {};
    parsed.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    return params;
  } catch {
    return {};
  }
}
