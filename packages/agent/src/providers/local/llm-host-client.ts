/**
 * Platform-pure contract for driving built-in local LLM inference that runs
 * somewhere else (e.g. the desktop hidden llm-host renderer, reached from the
 * Electron main process over IPC).
 *
 * packages/agent must stay free of Electron imports; hosts implement this
 * interface and inject it via `RuntimeData.localLlmHostClient`.
 */
import type { LocalLlmGenerationOptions, LocalLlmGenerationResult, LocalLlmMessage } from './types';

/** Cumulative progress snapshots reported while a generation is in flight. */
export interface LocalLlmHostProgress {
  file?: string;
  kind: 'loading' | 'reasoning' | 'stage' | 'text';
  message?: string;
  progress?: number;
  /** Cumulative reasoning text emitted so far. */
  reasoningText?: string;
  /** Cumulative visible text emitted so far. */
  text?: string;
}

/**
 * Generation options that survive the host boundary. Stream callbacks and
 * AbortSignals are not serializable; progress/cancellation are carried by
 * `LocalLlmHostRequestOptions` instead.
 */
export type LocalLlmHostGenerationOptions = Omit<LocalLlmGenerationOptions, 'signal' | 'stream'>;

export interface LocalLlmHostGenerateRequest {
  messages: LocalLlmMessage[];
  modelId: string;
  options?: LocalLlmHostGenerationOptions;
}

export interface LocalLlmHostRequestOptions {
  onProgress?: (progress: LocalLlmHostProgress) => void;
  signal?: AbortSignal;
}

export interface LocalLlmHostClient {
  generate(
    request: LocalLlmHostGenerateRequest,
    options?: LocalLlmHostRequestOptions
  ): Promise<LocalLlmGenerationResult>;
  /** Load (and download if needed) the model ahead of the first generation. */
  warmup(modelId: string, options?: LocalLlmHostRequestOptions): Promise<void>;
}
