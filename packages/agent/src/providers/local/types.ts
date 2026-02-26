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
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description?: string }>;
      required?: string[];
    };
  };
  type: 'function';
}

/**
 * Chat message format for local LLMs
 */
export interface LocalLlmMessage {
  content: string;
  name?: string;
  role: 'system' | 'user' | 'assistant' | 'developer' | 'tool';
  toolCallId?: string;
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
  temperature?: number;
  tools?: LocalLlmToolDefinition[];
  topK?: number;
  topP?: number;
}

/**
 * Result from local LLM generation
 */
export interface LocalLlmGenerationResult {
  finishReason: 'stop' | 'length' | 'tool_calls';
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
  stage: 'downloading' | 'loading' | 'ready';
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
