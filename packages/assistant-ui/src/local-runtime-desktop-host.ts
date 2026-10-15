/**
 * Desktop hidden llm-host bridge for the built-in local provider.
 *
 * Built-in local inference runs ONLY in the desktop app's hidden llm-host
 * renderer (ADR-0007/0015), proxied into the normal assistant-server run loop.
 * This module is the renderer-side view of that bridge: it answers whether the
 * host exists at all, and warms a model with download progress BEFORE the
 * assistant server starts streaming, so the panel shows the same loading badge
 * it always has instead of a silent stall on first use.
 *
 * Absence is never papered over — `hasDesktopLlmHost()` reporting `false` means
 * the built-in local provider is unavailable on this host, and callers must
 * refuse visibly rather than substitute another engine.
 */

import { hasDesktopLlmHost } from '@brainstrike/assistant-contract/local-llm-device';

export interface LocalRuntimeLoadingProgress {
  file?: string;
  message: string;
  progress: number;
  stage: 'downloading' | 'generating' | 'loading' | 'ready';
}

export type LocalRuntimeLoadingProgressCallback = (progress: LocalRuntimeLoadingProgress) => void;

/**
 * The slice of the preload-exposed llm-host bridge this module uses. The real
 * bridge also carries generation methods; warming deliberately declares only
 * what it calls.
 */
export interface DesktopLlmHost {
  onProgress?: (callback: (progress: unknown) => void) => () => void;
  onStatus?: (callback: (status: { runtimeKind: 'llm-host'; state: string }) => void) => () => void;
  warmup?: (payload: { modelId: string; requestId?: string } | string) => Promise<void>;
}

/** The host's loading reports; `warmup` only ever emits `kind: 'loading'`. */
interface LlmHostLoadingProgressEvent {
  payload: {
    clientRequestId?: string;
    file?: string;
    kind?: 'loading' | 'reasoning' | 'stage' | 'text';
    message?: string;
    progress?: number;
  };
  requestId: string;
  type: 'progress';
}

const warmedModelIds = new Set<string>();
const warmupPromises = new Map<string, Promise<void>>();
const warmupRequestIds = new Map<string, string>();

let hostStatusSyncInstalled = false;
let hostStatusUnsubscribe: (() => void) | null = null;
let hostStatusSource: object | null = null;

function isLlmHostLoadingProgressEvent(value: unknown): value is LlmHostLoadingProgressEvent {
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

function getDesktopLlmHost(): DesktopLlmHost | null {
  if (!hasDesktopLlmHost()) {
    return null;
  }
  const hostWindow = window as Window & {
    llmHost?: DesktopLlmHost;
  };
  return hostWindow.llmHost ?? null;
}

/** Forward one warmup progress report, ignoring events for other requests. */
export function handleDesktopLoadingProgressEvent(
  progress: unknown,
  requestId: string,
  onLoadingProgress: LocalRuntimeLoadingProgressCallback | undefined
): void {
  if (!isLlmHostLoadingProgressEvent(progress) || progress.payload.clientRequestId !== requestId) {
    return;
  }
  if (progress.payload.kind !== 'loading') {
    return;
  }
  onLoadingProgress?.({
    message: progress.payload.message ?? 'Loading Gemma local model',
    progress: progress.payload.progress ?? 0,
    stage: 'loading',
    ...(progress.payload.file ? { file: progress.payload.file } : {}),
  });
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

async function waitForAbortableWarmup(
  warmupPromise: Promise<void>,
  abortSignal: AbortSignal | undefined
): Promise<void> {
  if (!abortSignal) {
    await warmupPromise;
    return;
  }

  if (abortSignal.aborted) {
    throw createAbortError();
  }

  await new Promise<void>((resolve, reject) => {
    const handleAbort = () => {
      reject(createAbortError());
    };

    abortSignal.addEventListener('abort', handleAbort, { once: true });
    warmupPromise.then(
      () => {
        abortSignal.removeEventListener('abort', handleAbort);
        resolve();
      },
      (error: unknown) => {
        abortSignal.removeEventListener('abort', handleAbort);
        reject(error);
      }
    );
  });
}

/**
 * Drop the "already warm" memo when the host dies or restarts, so the next turn
 * warms again instead of trusting a model that no longer exists in that host.
 */
function ensureHostStateSync(llmHost: DesktopLlmHost): void {
  if (!llmHost.onStatus) {
    return;
  }
  if (hostStatusSource === llmHost && hostStatusSyncInstalled) {
    return;
  }

  hostStatusUnsubscribe?.();
  hostStatusSource = llmHost;
  hostStatusUnsubscribe = llmHost.onStatus((status) => {
    if (status.state === 'error' || status.state === 'stopped') {
      warmedModelIds.clear();
      warmupPromises.clear();
    }
  });
  hostStatusSyncInstalled = true;
}

async function ensureModelWarmed(
  llmHost: DesktopLlmHost,
  modelId: string,
  onLoadingProgress: LocalRuntimeLoadingProgressCallback | undefined,
  abortSignal?: AbortSignal
): Promise<void> {
  if (warmedModelIds.has(modelId)) {
    return;
  }

  const existingWarmup = warmupPromises.get(modelId);
  if (existingWarmup) {
    await waitForAbortableWarmup(existingWarmup, abortSignal);
    return;
  }

  let currentWarmupPromise: Promise<void> | null = null;
  const nextWarmupPromise = (async () => {
    const warmupRequestId = crypto.randomUUID();
    warmupRequestIds.set(modelId, warmupRequestId);
    onLoadingProgress?.({
      message: 'Starting local model host...',
      progress: 0,
      stage: 'loading',
    });
    const unsubscribeWarmupProgress = llmHost.onProgress?.((progress: unknown) => {
      handleDesktopLoadingProgressEvent(progress, warmupRequestId, onLoadingProgress);
    });
    try {
      if (!llmHost.warmup) {
        throw new Error('Desktop llm host does not implement warmup.');
      }
      await llmHost.warmup({ modelId, requestId: warmupRequestId });
      warmedModelIds.add(modelId);
    } finally {
      if (warmupRequestIds.get(modelId) === warmupRequestId) {
        warmupRequestIds.delete(modelId);
      }
      unsubscribeWarmupProgress?.();
      if (currentWarmupPromise && warmupPromises.get(modelId) === currentWarmupPromise) {
        warmupPromises.delete(modelId);
      }
    }
  })();
  currentWarmupPromise = nextWarmupPromise;

  warmupPromises.set(modelId, nextWarmupPromise);
  await waitForAbortableWarmup(nextWarmupPromise, abortSignal);
}

/**
 * Warm the built-in local model on the desktop hidden llm-host with download
 * progress surfaced to the caller, so the panel shows the loading badge before
 * the assistant server starts streaming. Concurrent callers share one warmup.
 */
export async function warmDesktopLocalModel(args: {
  modelId: string;
  onLoadingProgress?: LocalRuntimeLoadingProgressCallback;
  signal?: AbortSignal;
}): Promise<void> {
  const llmHost = getDesktopLlmHost();
  if (!llmHost) {
    throw new Error('Desktop llm host bridge is unavailable; cannot warm the local model.');
  }
  ensureHostStateSync(llmHost);
  await ensureModelWarmed(llmHost, args.modelId, args.onLoadingProgress, args.signal);
}

/** Test seam: forget warm models and host-status wiring between cases. */
export function __resetDesktopLlmHostStateForTests(): void {
  warmedModelIds.clear();
  warmupPromises.clear();
  warmupRequestIds.clear();
  hostStatusUnsubscribe?.();
  hostStatusUnsubscribe = null;
  hostStatusSource = null;
  hostStatusSyncInstalled = false;
}
