/**
 * Server-safe exports for the stateless Hosted Web assistant.
 *
 * Keep this entrypoint deliberately narrow. In particular, it must never
 * re-export the browser-local Transformers runtime or PGlite-backed stores:
 * Vercel traces every reachable package dependency into each function.
 */

export { AssistantAttachmentValidationError } from '@brainstrike/assistant-contract';
export { PROVIDER_DEFAULT_MODELS } from '@brainstrike/assistant-contract/provider-metadata';
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
export type { AssistantRequestPayload } from './assistant-request';
export {
  AssistantInvalidJsonError,
  AssistantRequestBodyTooLargeError,
  AssistantRequestEnvelopeValidationError,
  hasAssistantPromptContent,
  parseAssistantRequestPayloadText,
  readRequestBodyText,
} from './assistant-request';
export {
  convertAssistantUiMessagesWithFinalInput,
  toAiSdkStyleStream,
} from './message-utils';
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
