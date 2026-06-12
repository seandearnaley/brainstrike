/**
 * Local LLM provider for browser-based inference using transformers.js
 */

export {
  createLlmHostChatModel,
  LlmHostChatModel,
  type LlmHostChatModelSettings,
} from './llm-host-chat-model';
export type {
  LocalLlmHostClient,
  LocalLlmHostGenerateRequest,
  LocalLlmHostGenerationOptions,
  LocalLlmHostProgress,
  LocalLlmHostRequestOptions,
} from './llm-host-client';
export {
  createLocalHostEmbeddingModel,
  type LocalEmbeddingHostClient,
  type LocalEmbeddingHostQuery,
} from './local-host-embedding-model';
export { createLocalLanguageModel, LocalLanguageModel } from './local-language-model';
export {
  addAllowedModels,
  getAllowedModels,
  isModelAllowed,
  LocalLlmBackend,
  setModelChecksums,
  verifyModelIntegrity,
} from './local-llm-backend';
export {
  convertPromptToLocalMessages,
  convertToolsFromArray,
  extractTextFromParts,
  extractToolCallsFromParts,
  generateStreamPartId,
  mapFinishReason,
  parseToolResultMessage,
  segmentTextForStream,
} from './local-message-conversion';
export type {
  LocalLlmConfig,
  LocalLlmGenerationOptions,
  LocalLlmGenerationResult,
  LocalLlmJsonSchema,
  LocalLlmMessage,
  LocalLlmModelCapabilities,
  LocalLlmModelParameters,
  LocalLlmProgressCallback,
  LocalLlmProviderStatus,
  LocalLlmToolCall,
  LocalLlmToolDefinition,
  LocalLlmToolResponse,
} from './types';
