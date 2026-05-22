export { HybridExecutionEngine } from "./src/executor/hybrid-engine.ts";
export { StealthBrowser } from "./src/core/browser.ts";
export { AuthHandler } from "./src/auth/auth-handler.ts";
export { CaptchaResolver } from "./src/captcha/captcha-resolver.ts";
export { DomController } from "./src/core/dom-controller.ts";
export { VisionController } from "./src/core/vision-controller.ts";
export { SessionRecorder } from "./src/recorder/session-recorder.ts";
export { selectStrategy } from "./src/router/strategy-router.ts";

export type { HybridExecutionResult, HybridEngineConfig } from "./src/executor/hybrid-engine.ts";
export type { BrowserConfig } from "./src/core/browser.ts";
export type { AuthConfig, AuthResult, AuthCredentials } from "./src/auth/auth-handler.ts";
export type { CaptchaConfig, CaptchaResult } from "./src/captcha/captcha-resolver.ts";
export type { VisionConfig, VisionResult } from "./src/core/vision-controller.ts";
export type { DomAction, DomResult } from "./src/core/dom-controller.ts";
export type { ExecutionStrategy, StrategyResult } from "./src/router/strategy-router.ts";
export type { RecordedWorkflow } from "./src/recorder/types.ts";
export type { ApiGraph, GraphNode } from "./src/graph/types.ts";