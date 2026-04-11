/**
 * Dedicated local LLM entrypoint.
 *
 * This entry intentionally isolates the Transformers-backed local runtime from
 * `./client` so renderer startup code can import browser-safe metadata without
 * inheriting top-level async module initialization.
 */

import {
  addAllowedModels,
  LocalLlmBackend as BaseLocalLlmBackend,
  getAllowedModels,
  isModelAllowed,
  setModelChecksums,
  verifyModelIntegrity,
} from './providers/local/local-llm-backend';

export {
  addAllowedModels,
  getAllowedModels,
  isModelAllowed,
  setModelChecksums,
  verifyModelIntegrity,
};

export class LocalLlmBackend extends BaseLocalLlmBackend {}
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
} from './providers/local/types';
