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
export {
  decideVisualActions,
  visionToSemantic,
  extractTextFromRegion,
  type VisionConfig,
  type VisionAction,
  type MultimodalResult,
  type OCRResult,
} from "./multimodal-perception.ts";
export {
  queryVisualElements,
  findElementByDescription,
  normalizedToCDPCoords,
  type GroundedElement,
  type BoundingBox,
  type GroundingResult,
} from "./visual-grounding.ts";
export {
  fusePageModel,
  resolveWithVision,
  executeCanvasAction,
  type FusionResult,
  type FusionMode,
  type FusionConfig,
} from "./vision-fusion.ts";
export {
  Planner,
  Executor,
  Verifier,
  Recovery,
  Orchestrator,
  type Plan,
  type SubTask,
  type PlannerResult,
  type ExecutorResult,
  type OrchestratorResult,
  type OrchestratorConfig,
} from "./planner-executor.ts";
export {
  loadIntelligence,
  saveIntelligence,
  recordFailure,
  getRecoveryForFailure,
  recordSelectorResult,
  getBestSelector,
  recordTiming,
  getRecommendedDelay,
  recordAuthFlow,
  getAuthFlow,
  recordWorkflowRun,
  getWorkflowStats,
  addHeuristic,
  getHeuristics,
  listIntelligence,
  type SiteIntelligence,
  type FailurePattern,
  type AuthFlow,
  type SelectorReliability,
} from "./site-intelligence.ts";
export {
  composeSkills,
  discoverSkillChain,
  toMarketplaceFormat,
  type SkillDependency,
  type ComposedSkill,
} from "./skills.ts";
