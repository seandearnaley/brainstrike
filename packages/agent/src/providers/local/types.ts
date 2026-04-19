/**
 * Types for local LLM inference using transformers.js
 */

/**
 * Tool/function definition for local LLM function calling
 */
export interface LocalLlmToolDefinition {
  function: {
    name: string;
    description: string;
    parameters: LocalLlmJsonSchema & { type: 'object' };
  };
  type: 'function';
}

export interface LocalLlmJsonSchema {
  additionalProperties?: boolean;
  description?: string;
  enum?: string[];
  items?: LocalLlmJsonSchema;
  properties?: Record<string, LocalLlmJsonSchema>;
  required?: string[];
  type: string;
}

export interface LocalLlmToolResponse {
  name: string;
  response: unknown;
}

/**
 * Chat message format for local LLMs
 */
export interface LocalLlmMessage {
  content: string;
  name?: string;
  role: 'system' | 'user' | 'assistant' | 'developer' | 'tool';
  toolCallId?: string;
  toolCalls?: LocalLlmToolCall[];
  toolResponses?: LocalLlmToolResponse[];
}

/**
 * Tool call result from model output
 */
export interface LocalLlmToolCall {
  function: {
    name: string;
    arguments: string;
  };
  id: string;
  type: 'function';
}

/**
 * Generation options for local LLM
 */
export interface LocalLlmGenerationOptions {
  doSample?: boolean;
  maxNewTokens?: number;
  repetitionPenalty?: number;
  signal?: AbortSignal;
  stream?: {
    onReasoningSnapshot?: (text: string) => void;
    onStageChange?: (stage: 'generating' | 'reasoning' | 'responding') => void;
    onTextSnapshot?: (text: string) => void;
  };
  temperature?: number;
  thinking?: {
    enabled?: boolean;
  };
  tools?: LocalLlmToolDefinition[];
  topK?: number;
  topP?: number;
}

/**
 * Result from local LLM generation
 */
export interface LocalLlmGenerationResult {
  finishReason: 'stop' | 'length' | 'tool_calls';
  reasoningText?: string;
  text: string;
  toolCalls?: LocalLlmToolCall[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Progress callback for model loading
 */
export type LocalLlmProgressCallback = (progress: {
  stage: 'downloading' | 'generating' | 'loading' | 'ready';
  progress: number;
  message: string;
  file?: string;
}) => void;

/**
 * Configuration for local LLM provider
 */
export interface LocalLlmConfig {
  device?: 'webgpu' | 'wasm';
  modelId: string;
  onProgress?: LocalLlmProgressCallback;
  quantized?: boolean;
}

/**
 * Local LLM model capabilities
 */
export interface LocalLlmModelCapabilities {
  contextWindow: number;
  streaming: boolean;
  toolCalling: boolean;
  type: 'llm';
}

/**
 * Local LLM model parameters
 */
export interface LocalLlmModelParameters {
  architecture: string;
  quantization: string;
  size: string;
}

/**
 * Status of a local LLM provider
 */
export type LocalLlmProviderStatus =
  | { state: 'uninitialized' }
  | { state: 'loading'; progress: number; message: string }
  | { state: 'ready'; device: string }
  | { state: 'error'; error: string };
