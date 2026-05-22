/**
 * Sound Browser (Semantic Orchestration Unified Network Discovery)
 * A full-fledged browser for AI agents.
 * Exposes the web as structured data that LLMs can read and manipulate natively.
 */

export { CDPBridge, type CDPBrowserConfig } from "./cdp-bridge.ts";
export {
  extractSemanticPage,
  type SemanticPage,
  type SemanticForm,
  type SemanticField,
  type SemanticButton,
  type SemanticLink,
  type SemanticContentBlock,
  type SemanticInteractive,
  type SemanticTable,
  type SemanticList,
  type SemanticSearch,
  type SemanticMedia,
} from "./semantic-page.ts";
export {
  executeSemanticAction,
  type SemanticAction,
  type ActionResult,
} from "./action-resolver.ts";
export {
  createSession,
  getSession,
  closeSession,
  refreshPageModel,
  executeAction,
  listSessions,
  cleanupStaleSessions,
  type SessionConfig,
  type BrowserSession,
} from "./session-manager.ts";
export {
  createStreamObserver,
  type PageMutation,
  type StreamObserver,
} from "./stream-observer.ts";
export {
  SemanticAuthHandler,
  type AuthCredentials,
  type AuthConfig,
  type AuthResult,
} from "./semantic-auth.ts";
export {
  SemanticCaptchaResolver,
  type CaptchaConfig,
  type CaptchaResult,
} from "./semantic-captcha.ts";
