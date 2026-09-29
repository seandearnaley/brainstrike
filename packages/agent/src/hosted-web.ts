/**
 * Server-safe exports for the stateless Hosted Web assistant.
 *
 * Keep this entrypoint deliberately narrow. In particular, it must never
 * re-export the browser-local Transformers runtime or PGlite-backed stores:
 * Vercel traces every reachable package dependency into each function.
 */

export { AssistantAttachmentValidationError } from '@brainstrike/assistant-contract/assistant-attachments';
export {
  OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET,
  type RuntimeAssistantMemorySettings,
  resolveAutoObservationalMemoryModelTarget,
} from '@brainstrike/assistant-contract/memory-settings';
// BST-1361: the deprecated-name detector reads only the env map it is
// handed — server-side callers pass their own process env, never wire data.
export {
  type DeprecatedEnvVarReport,
  detectDeprecatedProviderEnvVars,
  isSupportedProvider,
  PROVIDER_DEFAULT_MODELS,
  providerDeprecatedEnvKeys,
  providerEnvKeys,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
// Sourced from the contract subpath rather than './types' so this entrypoint's
// './types' edge stays type-only. The Hosted Web request boundary validates
// `RuntimeData.requestedReasoningEffort` against it, and deriving the wire enum
// from the same declaration that types the field is the whole point — a
// hand-listed copy is free to accept more or less than the type admits.
export { OPENAI_REASONING_EFFORT_VALUES } from '@brainstrike/assistant-contract/runtime-data';
export type {
  AssistantToolApprovalAction,
  AssistantToolApprovalDecision,
} from '@brainstrike/assistant-contract/tool-approval';
export { readToolApprovalRunConfigAction } from '@brainstrike/assistant-contract/tool-approval';
export type { AssistantToolResumeAction } from '@brainstrike/assistant-contract/tool-suspend';
export { readToolResumeRunConfigAction } from '@brainstrike/assistant-contract/tool-suspend';
export {
  AssistantMessageValidationError,
  assertAssistantMessageGraphWithinLimits,
} from './assistant-message-boundary';
export type { ParsedAssistantRequestEnvelope } from './assistant-request';
export {
  AssistantInvalidJsonError,
  AssistantRequestBodyTooLargeError,
  AssistantRequestEnvelopeValidationError,
  hasAssistantPromptContent,
  parseAssistantRequestPayloadText,
  readRequestBodyText,
} from './assistant-request';
export {
  type AssistantUiMessageConversionResult,
  convertAssistantUiMessagesWithFinalInput,
  toAiSdkStyleStream,
} from './message-utils';
// The provider auth seam (BST-1352): Hosted Web adapts its env-resolved key
// via `kind: 'api_key'` only (no typed-credential resolution on web).
export type { ProviderAuthInput } from './providers/provider-auth-input';
// Slim by construction: tool-categories has zero imports. Lets the shared
// assistant-service preparation validate native-tool ids without dragging the
// agent ROOT entry (and its Mastra/Node graph) into traced Vercel functions.
export { DESKTOP_NATIVE_TOOL_IDS } from './registry/tool-categories';
export {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  AssistantRequestBodyLimitConfigError,
  HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
  resolveAssistantRequestBodyLimitBytes,
} from './request-boundary';
export { createStatelessAssistantDataStreamResponse } from './stream/data-stream';
export type {
  AgentMessage,
  RuntimeData,
  StreamChunk,
  StreamIterator,
} from './types';
