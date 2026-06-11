export const GEMMA4_E2B_MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX' as const;
export const GEMMA4_E2B_REVISION = '30b3854c1ca3e0f08981e1a439de9fbd9245a3a9' as const;

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

export interface LocalLlmMessage {
  content: string;
  name?: string;
  role: 'system' | 'user' | 'assistant' | 'developer' | 'tool';
  toolCallId?: string;
  toolCalls?: LocalLlmToolCall[];
  toolResponses?: LocalLlmToolResponse[];
}

export interface LocalLlmToolCall {
  function: {
    name: string;
    arguments: string;
  };
  id: string;
  type: 'function';
}

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

export interface LocalLlmGenerationResult {
  finishReason: 'stop' | 'length' | 'tool_calls';
  reasoningText?: string;
  text: string;
  toolCalls?: LocalLlmToolCall[];
  /**
   * Tokenizer-true usage for this generation. The built-in Gemma engine always
   * produces it, but results cross the desktop IPC boundary (hidden llm-host →
   * visible renderer), so a host implementation may omit it. Consumers must
   * guard before reading.
   */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export type LocalLlmProgressCallback = (progress: {
  stage: 'downloading' | 'generating' | 'loading' | 'ready';
  progress: number;
  message: string;
  file?: string;
}) => void;

export interface LocalLlmConfig {
  device?: 'webgpu' | 'wasm';
  modelId: string;
  onProgress?: LocalLlmProgressCallback;
  quantized?: boolean;
}

export interface LocalLlmModelCapabilities {
  contextWindow: number;
  streaming: boolean;
  toolCalling: boolean;
  type: 'llm';
}

export interface LocalLlmModelParameters {
  architecture: string;
  quantization: string;
  size: string;
}

export type LocalLlmProviderStatus =
  | { state: 'uninitialized' }
  | { state: 'loading'; progress: number; message: string }
  | { state: 'ready'; device: string }
  | { state: 'error'; error: string };

export interface LocalLlmBackend {
  dispose(): Promise<void>;
  generate(
    messages: LocalLlmMessage[],
    options?: LocalLlmGenerationOptions
  ): Promise<LocalLlmGenerationResult>;
  initialize(config: { modelId: string; onProgress?: LocalLlmProgressCallback }): Promise<void>;
  isReady(): boolean;
}

export type LocalLlmBackendFactory = () => Promise<LocalLlmBackend>;
