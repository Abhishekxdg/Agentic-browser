export interface EndpointParam {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  required: boolean;
  source: "query" | "body" | "path";
}

export interface OutputExtractor {
  field: string;    // logical name, e.g. "invoice_id"
  jsonpath: string; // e.g. "$.id" or "$.data.invoice_id"
}

export interface ParamBinding {
  source_extractor: string; // field name from OutputExtractor
  target_param: string;     // param name in the next endpoint
  target_location: "query" | "body" | "path";
}

export interface Endpoint {
  method: string;
  url_template: string;
  params: EndpointParam[];
  auth_type: "bearer" | "cookie" | "none" | "basic";
  prerequisite_endpoints: string[]; // url_templates that must be called first
  success_indicators: number[];     // expected HTTP status codes
  output_extractors: OutputExtractor[];
  param_bindings: ParamBinding[];   // how this endpoint's outputs bind to next endpoints
  request_body_schema?: Record<string, unknown>;
}

export interface RecordedWorkflow {
  name: string;
  site_url: string;
  endpoints: Endpoint[];
  recorded_at: Date;
  sequence: string[]; // ordered url_templates
}

export type RecordingSession = {
  name: string;
  site_url: string;
  captured: CapturedRequest[];
  started_at: Date;
};

export type CapturedRequest = {
  method: string;
  url: string;
  url_template: string;
  request_headers: Record<string, string>;
  request_body: unknown;
  response_status: number;
  response_body: unknown;
  response_headers: Record<string, string>;
  timestamp: number;
};
