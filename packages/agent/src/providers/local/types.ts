/**
 * Types for local LLM inference using transformers.js
 */

/**
 * Tool/function definition for local LLM function calling
 */
export type LocalLlmToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description?: string }>;
      required?: string[];
    };
  };
};

/**
 * Chat message format for local LLMs
 */
export type LocalLlmMessage = {
  role: 'system' | 'user' | 'assistant' | 'developer' | 'tool';
  content: string;
  toolCallId?: string;
  name?: string;
};

/**
 * Tool call result from model output
 */
export type LocalLlmToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

/**
 * Generation options for local LLM
 */
export type LocalLlmGenerationOptions = {
  maxNewTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  doSample?: boolean;
  repetitionPenalty?: number;
  tools?: LocalLlmToolDefinition[];
  signal?: AbortSignal;
};

/**
 * Result from local LLM generation
 */
export type LocalLlmGenerationResult = {
  text: string;
  toolCalls?: LocalLlmToolCall[];
  finishReason: 'stop' | 'length' | 'tool_calls';
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

/**
 * Progress callback for model loading
 */
export type LocalLlmProgressCallback = (progress: {
  stage: 'downloading' | 'loading' | 'ready';
  progress: number;
  message: string;
  file?: string;
}) => void;

/**
 * Configuration for local LLM provider
 */
export type LocalLlmConfig = {
  modelId: string;
  device?: 'webgpu' | 'wasm';
  quantized?: boolean;
  onProgress?: LocalLlmProgressCallback;
};

/**
 * Local LLM model capabilities
 */
export type LocalLlmModelCapabilities = {
  type: 'llm';
  streaming: boolean;
  toolCalling: boolean;
  contextWindow: number;
};

/**
 * Local LLM model parameters
 */
export type LocalLlmModelParameters = {
  size: string;
  architecture: string;
  quantization: string;
};

/**
 * Status of a local LLM provider
 */
export type LocalLlmProviderStatus =
  | { state: 'uninitialized' }
  | { state: 'loading'; progress: number; message: string }
  | { state: 'ready'; device: string }
  | { state: 'error'; error: string };
