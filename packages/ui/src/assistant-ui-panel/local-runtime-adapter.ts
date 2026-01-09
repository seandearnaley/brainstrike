/**
 * Local runtime adapter for browser-based LLM inference.
 * Uses LocalLlmBackend from @brainstrike/agent/client for in-browser inference
 * with transformers.js (ONNX models via WebGPU/WASM).
 */
import type { ChatModelAdapter, ChatModelRunOptions } from '@assistant-ui/react';
import type {
  LocalLlmBackend as LocalLlmBackendType,
  LocalLlmGenerationResult,
  LocalLlmMessage,
} from '@brainstrike/agent/client';

// Singleton backend instance - persists across renders to avoid reloading model
let backendInstance: LocalLlmBackendType | null = null;
let currentModelId: string | null = null;

/**
 * Get or create the LocalLlmBackend singleton.
 * Dynamically imports to avoid loading transformers.js until needed.
 */
async function getBackend(): Promise<LocalLlmBackendType> {
  if (backendInstance) {
    return backendInstance;
  }

  // Dynamic import to avoid bundling transformers.js in non-local builds
  const { LocalLlmBackend } = await import('@brainstrike/agent/client');
  backendInstance = new LocalLlmBackend();
  return backendInstance;
}

/**
 * Convert assistant-ui ThreadMessage to LocalLlmMessage format
 */
function convertMessages(messages: ChatModelRunOptions['messages']): LocalLlmMessage[] {
  const result: LocalLlmMessage[] = [];

  for (const msg of messages) {
    // Extract text content from message parts
    const textContent = msg.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n');

    if (textContent.trim().length === 0) {
      continue;
    }

    // Map assistant-ui roles to LocalLlmMessage roles
    const role = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : 'system';

    result.push({
      role,
      content: textContent,
    });
  }

  return result;
}

export type LocalRuntimeAdapterOptions = {
  modelId: string;
  onLoadingProgress?: (progress: {
    stage: 'downloading' | 'loading' | 'ready';
    progress: number;
    message: string;
    file?: string;
  }) => void;
  onError?: (error: Error) => void;
};

/**
 * Create a ChatModelAdapter for local browser-based LLM inference.
 * This adapter uses LocalLlmBackend which runs entirely in the browser
 * using transformers.js with WebGPU or WASM acceleration.
 */
export function createLocalModelAdapter(options: LocalRuntimeAdapterOptions): ChatModelAdapter {
  const { modelId, onLoadingProgress, onError } = options;

  return {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Generator handles init, conversion, streaming, and errors
    async *run({ messages, abortSignal }) {
      try {
        const backend = await getBackend();

        // Initialize with the selected model if not already loaded
        if (!backend.isReady() || currentModelId !== modelId) {
          await backend.initialize({
            modelId,
            // Only include onProgress when defined (exactOptionalPropertyTypes compliance)
            ...(onLoadingProgress ? { onProgress: onLoadingProgress } : {}),
          });
          currentModelId = modelId;
        }

        // Convert messages to LocalLlmMessage format
        const localMessages = convertMessages(messages);

        if (localMessages.length === 0) {
          yield {
            content: [{ type: 'text', text: 'No message content to process.' }],
          };
          return;
        }

        // Generate response
        const result: LocalLlmGenerationResult = await backend.generate(localMessages, {
          maxNewTokens: 1024,
          temperature: 0.7,
          signal: abortSignal,
        });

        // Build response content parts
        const contentParts: Array<
          | { type: 'text'; text: string }
          | {
              type: 'tool-call';
              toolCallId: string;
              toolName: string;
              args: object;
              argsText: string;
            }
        > = [];

        // Add text content
        if (result.text && result.text.trim().length > 0) {
          contentParts.push({ type: 'text', text: result.text });
        }

        // Add tool calls if present
        if (result.toolCalls && result.toolCalls.length > 0) {
          for (const toolCall of result.toolCalls) {
            let parsedArgs: object = {};
            try {
              parsedArgs = JSON.parse(toolCall.function.arguments) as object;
            } catch {
              // Malformed arguments - fall back to empty object
              // The argsText field still contains the raw arguments for debugging
            }
            contentParts.push({
              type: 'tool-call',
              toolCallId: toolCall.id,
              toolName: toolCall.function.name,
              args: parsedArgs,
              argsText: toolCall.function.arguments,
            });
          }
        }

        // Yield with type assertion - contentParts satisfies assistant-ui's structure
        // JSON.parse returns valid JSON which is compatible with ReadonlyJSONObject
        yield { content: contentParts } as Parameters<ChatModelAdapter['run']> extends [infer _Opts]
          ? never
          : { content: typeof contentParts };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Check for abort
        if (error instanceof DOMException && error.name === 'AbortError') {
          yield {
            content: [{ type: 'text', text: 'Generation cancelled.' }],
          };
          return;
        }

        onError?.(error instanceof Error ? error : new Error(errorMessage));

        yield {
          content: [
            {
              type: 'text',
              text: `Local model error: ${errorMessage}. Make sure the model is downloaded and WebGPU/WASM is available.`,
            },
          ],
        };
      }
    },
  };
}

/**
 * Dispose the backend and free resources.
 * Call this when the local provider is no longer needed.
 */
export async function disposeLocalBackend(): Promise<void> {
  if (backendInstance) {
    await backendInstance.dispose();
    backendInstance = null;
    currentModelId = null;
  }
}

/**
 * Check if local inference is available in the current environment.
 */
export function isLocalInferenceAvailable(): boolean {
  // Check for browser environment
  if (typeof window === 'undefined') {
    return false;
  }

  // Check for WebGPU or WASM support
  const hasWebGPU = 'gpu' in navigator;
  const hasWASM = typeof WebAssembly !== 'undefined';

  return hasWebGPU || hasWASM;
}

/**
 * Get the best available device for local inference.
 */
export function getBestInferenceDevice(): 'webgpu' | 'wasm' | null {
  if (typeof window === 'undefined') {
    return null;
  }

  if ('gpu' in navigator) {
    return 'webgpu';
  }

  if (typeof WebAssembly !== 'undefined') {
    return 'wasm';
  }

  return null;
}
