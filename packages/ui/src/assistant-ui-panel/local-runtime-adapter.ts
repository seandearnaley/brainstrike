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

/**
 * JSON types compatible with assistant-ui's ReadonlyJSONObject.
 * Defined locally since assistant-stream is a transitive dependency.
 */
type JsonValue = null | string | number | boolean | JsonObject | JsonArray;
interface JsonObject {
  readonly [key: string]: JsonValue;
}
type JsonArray = readonly JsonValue[];

/**
 * Type guard to validate that a parsed JSON value is a valid JsonObject.
 * Prevents prototype pollution and ensures the value is a plain object.
 */
function isJsonObject(value: unknown): value is JsonObject {
  // Must be a non-null object
  if (!value || typeof value !== 'object') {
    return false;
  }

  // Must not be an array or null (typeof null === 'object')
  if (Array.isArray(value) || value === null) {
    return false;
  }

  // Prototype pollution prevention: only accept plain objects
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }

  return true;
}

// Singleton backend instance - persists across renders to avoid reloading model
let backendInstance: LocalLlmBackendType | null = null;
let backendInstancePromise: Promise<LocalLlmBackendType> | null = null;
let currentModelId: string | null = null;
// Track disposal lifecycle to prevent race conditions
// - requested: disposal has been requested (blocks new inits from returning soon-to-be-disposed instances)
// - inProgress: disposal is actively running (prevents new init while cleanup happens)
// - promise: Promise that resolves when disposal completes, allowing callers to wait
const disposalState: {
  requested: boolean;
  inProgress: boolean;
  promise: Promise<void> | null;
} = { requested: false, inProgress: false, promise: null };

/**
 * Get or create the LocalLlmBackend singleton.
 * Uses promise-based caching to prevent race conditions when called concurrently.
 * Dynamically imports to avoid loading transformers.js until needed.
 *
 * Handles edge cases:
 * - disposeLocalBackend() called during initialization: checks flag and disposes new instance
 * - getBackend() called during disposal: waits for disposal to complete first
 */
async function getBackend(): Promise<LocalLlmBackendType> {
  // If disposal is in progress, wait for it to complete before creating new instance
  // This prevents returning an instance that's about to be disposed
  if (disposalState.inProgress && disposalState.promise) {
    try {
      await disposalState.promise;
    } catch {
      // Disposal failed - that's ok, we'll create a fresh instance
    }
  }

  // Fast path: already initialized and not in disposal process
  if (backendInstance && !disposalState.requested && !disposalState.inProgress) {
    return backendInstance;
  }

  // Race condition protection: use promise-based cache
  // If initialization is in progress, wait for it instead of creating another instance
  if (!backendInstancePromise) {
    backendInstancePromise = (async () => {
      try {
        // Dynamic import to avoid bundling transformers.js in non-local builds
        const { LocalLlmBackend } = await import('@brainstrike/agent/client');
        const instance = new LocalLlmBackend();

        // Check if disposal was requested while we were initializing
        if (disposalState.requested) {
          // Disposal was requested - clean up the instance we just created
          await instance.dispose();
          // Clear the promise so future getBackend() calls create a fresh instance
          backendInstancePromise = null;
          throw new Error('Backend initialization cancelled: disposal was requested');
        }

        backendInstance = instance;
        return instance;
      } catch (error) {
        // Clear stale promise on any initialization failure to allow retry
        backendInstancePromise = null;
        throw error;
      }
    })();
  }

  return backendInstancePromise;
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

export interface LocalRuntimeAdapterOptions {
  modelId: string;
  onError?: (error: Error) => void;
  onLoadingProgress?: (progress: {
    stage: 'downloading' | 'loading' | 'ready';
    progress: number;
    message: string;
    file?: string;
  }) => void;
}

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
              args: JsonObject;
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
            let parsedArgs: JsonObject = {};
            try {
              const parsed: unknown = JSON.parse(toolCall.function.arguments);
              // Validate the parsed value is a plain object to prevent prototype pollution
              if (isJsonObject(parsed)) {
                parsedArgs = parsed;
              } else {
                // Parsed successfully but wasn't an object (e.g., array, primitive)
                // Fall back to empty object for safety
              }
            } catch {
              // Malformed JSON - fall back to empty object
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

        // Yield the response - contentParts uses Record<string, unknown> for JSON compatibility
        yield { content: contentParts };
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
 *
 * Handles race conditions:
 * - If initialization is in progress, waits and disposes the new instance
 * - If getBackend() is called during disposal, it waits for disposal to complete
 */
export async function disposeLocalBackend(): Promise<void> {
  // Prevent re-entry if disposal is already in progress
  if (disposalState.inProgress) {
    // Wait for existing disposal to complete
    if (disposalState.promise) {
      return disposalState.promise;
    }
    return;
  }

  // Signal disposal is starting
  disposalState.requested = true;
  disposalState.inProgress = true;

  // Create a promise that callers can wait on
  disposalState.promise = (async () => {
    try {
      // Wait for any pending initialization to complete before disposing
      if (backendInstancePromise) {
        try {
          await backendInstancePromise;
        } catch {
          // Initialization may have failed or been cancelled - that's ok
        }
      }

      // Now safely dispose the instance
      if (backendInstance) {
        await backendInstance.dispose();
      }
    } finally {
      // Reset all state - must happen even if disposal fails
      backendInstance = null;
      backendInstancePromise = null;
      currentModelId = null;
      disposalState.requested = false;
      disposalState.inProgress = false;
      disposalState.promise = null;
    }
  })();

  return disposalState.promise;
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
