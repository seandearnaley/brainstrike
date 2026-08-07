import type {
  LocalLlmGenerationOptions,
  LocalLlmGenerationResult,
  LocalLlmMessage,
} from '@brainstrike/assistant-contract';

export interface LocalRuntimeLoadingProgress {
  file?: string;
  message: string;
  progress: number;
  stage: 'downloading' | 'generating' | 'loading' | 'ready';
}

export type LocalRuntimeLoadingProgressCallback = (progress: LocalRuntimeLoadingProgress) => void;

export interface DesktopLlmHost {
  cancel?: (requestId: string) => Promise<void>;
  generate?: (payload: {
    requestId?: string;
    modelId: string;
    messages: LocalLlmMessage[];
    options?: LocalLlmGenerationOptions;
  }) => Promise<LocalLlmGenerationResult>;
  onProgress?: (callback: (progress: unknown) => void) => () => void;
  onStatus?: (callback: (status: { runtimeKind: 'llm-host'; state: string }) => void) => () => void;
  warmup?: (payload: { modelId: string; requestId?: string } | string) => Promise<void>;
}

interface LlmHostProgressEvent {
  payload: {
    clientRequestId?: string;
    file?: string;
    kind?: 'loading' | 'reasoning' | 'stage' | 'text';
    message?: string;
    progress?: number;
    reasoningText?: string;
    text?: string;
  };
  requestId: string;
  type: 'progress';
}

function isLlmHostProgressEvent(value: unknown): value is LlmHostProgressEvent {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { type?: unknown; payload?: unknown; requestId?: unknown };
  return (
    candidate.type === 'progress' &&
    typeof candidate.requestId === 'string' &&
    Boolean(candidate.payload && typeof candidate.payload === 'object')
  );
}

export function createGeneratingMessage(stage: string | undefined): string {
  return stage === 'reasoning' ? 'Thinking...' : 'Generating answer...';
}

export function createReadyMessage(): string {
  return 'Response complete.';
}

export function getDesktopLlmHost(): DesktopLlmHost | null {
  const hostWindow = window as Window & {
    llmHost?: DesktopLlmHost;
  };
  return hostWindow.llmHost ?? null;
}

export function createDesktopGenerationOptions(
  options: LocalLlmGenerationOptions
): Omit<LocalLlmGenerationOptions, 'signal'> {
  const { signal: _signal, ...cloneableOptions } = options;
  return cloneableOptions;
}

export function handleDesktopProgressEvent(
  progress: unknown,
  requestId: string,
  onLoadingProgress: LocalRuntimeLoadingProgressCallback | undefined,
  onReasoningSnapshot: (reasoningText: string) => void,
  onTextSnapshot: (text: string) => void
): void {
  if (!isLlmHostProgressEvent(progress) || progress.payload.clientRequestId !== requestId) {
    return;
  }

  if (progress.payload.kind === 'loading') {
    onLoadingProgress?.({
      message: progress.payload.message ?? 'Loading Gemma local model',
      progress: progress.payload.progress ?? 0,
      stage: 'loading',
      ...(progress.payload.file ? { file: progress.payload.file } : {}),
    });
    return;
  }

  if (progress.payload.kind === 'stage') {
    onLoadingProgress?.({
      message: createGeneratingMessage(progress.payload.message),
      progress: 0,
      stage: 'generating',
    });
    return;
  }

  if (progress.payload.kind === 'reasoning' && progress.payload.reasoningText) {
    onReasoningSnapshot(progress.payload.reasoningText);
    return;
  }

  if (progress.payload.kind === 'text' && progress.payload.text) {
    onTextSnapshot(progress.payload.text);
  }
}
