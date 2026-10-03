/// <reference lib="webworker" />

import {
  assertEmbedWorkerRequestControl,
  EMBED_WORKER_INSTANCE_NAME_PREFIX,
  EMBED_WORKER_REQUEST_CONTROL_CHANNEL_SUFFIX,
  EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY,
  type EmbedWorkerRequestControl,
  FUSED_MINILM_MODEL_ID,
} from '@brainstrike/indexing-contract';
import { DEFAULT_EMBEDDING_DIMENSION, MAX_EMBEDDING_DIMENSION } from '@brainstrike/types';
import type {
  FeatureExtractionPipeline,
  Tensor as TransformersTensor,
} from '@huggingface/transformers';
import { Transfer, worker, workerEmit } from 'workerpool';
import { createTokenBudgetBatchEnds, extractCappedEmbeddings } from './embedding-input-plan';
import {
  createEmbeddingPipelineCacheController,
  type PipelineCacheDiagnosticSink,
} from './pipeline-cache-controller';
import type {
  EmbeddingDevice,
  EmbeddingDeviceHint,
  EmbeddingDType,
  EmbedWorkerBatch,
  EmbedWorkerComplete,
  EmbedWorkerError,
  EmbedWorkerLifetimeError,
  EmbedWorkerPipelineCacheDiagnostic,
  EmbedWorkerProgress,
  EmbedWorkerRequest,
  EmbedWorkerSuccess,
  EmbedWorkerTelemetrySourceClosed,
} from './shared';
import {
  cloneAsFloat32,
  computeInitialBatchSize,
  l2Normalize,
  normalizeProgress,
  POWER_BROADCAST_CHANNEL,
  truncateVector,
  vectorsFromPipelineOutput,
} from './shared';
import { consumeEmbeddingWorkerTestRuntimeOverride } from './test-runtime-bootstrap';

function resolveEmbeddingWorkerInstanceId(): string {
  const workerName = (globalThis as typeof globalThis & { readonly name?: unknown }).name;
  if (workerName === undefined || workerName === '') {
    return globalThis.crypto.randomUUID();
  }
  if (
    !(typeof workerName === 'string' && workerName.startsWith(EMBED_WORKER_INSTANCE_NAME_PREFIX))
  ) {
    throw new Error('Embedding worker name does not match the managed identity contract.');
  }
  const workerInstanceId = workerName.slice(EMBED_WORKER_INSTANCE_NAME_PREFIX.length);
  if (workerInstanceId.length === 0) {
    throw new Error('Embedding worker name is missing its required instance identity.');
  }
  return workerInstanceId;
}

const embeddingWorkerInstanceId = resolveEmbeddingWorkerInstanceId();

function resolveWorkerpoolTelemetryChannelName(): string | null {
  const workerLocation = (
    globalThis as typeof globalThis & { readonly location?: { readonly hash?: unknown } }
  ).location;
  if (!(workerLocation && typeof workerLocation.hash === 'string')) {
    return null;
  }

  const fragment = workerLocation.hash.startsWith('#')
    ? workerLocation.hash.slice(1)
    : workerLocation.hash;
  const channelNames = new URLSearchParams(fragment).getAll(
    EMBED_WORKER_TELEMETRY_CHANNEL_FRAGMENT_KEY
  );
  if (channelNames.length === 0) {
    return null;
  }
  const channelName = channelNames[0];
  if (channelNames.length !== 1 || !channelName) {
    throw new Error('Embedding worker has an invalid worker-lifetime telemetry channel.');
  }
  return channelName;
}

function createWorkerpoolChannels(): {
  readonly requestControl: BroadcastChannel | null;
  readonly telemetry: BroadcastChannel | null;
} {
  const channelName = resolveWorkerpoolTelemetryChannelName();
  if (channelName === null) {
    return { requestControl: null, telemetry: null };
  }
  if (typeof BroadcastChannel === 'undefined') {
    throw new Error('Embedding workerpool telemetry requires BroadcastChannel support.');
  }
  const telemetry = new BroadcastChannel(channelName);
  try {
    return {
      requestControl: new BroadcastChannel(
        `${channelName}${EMBED_WORKER_REQUEST_CONTROL_CHANNEL_SUFFIX}`
      ),
      telemetry,
    };
  } catch (error) {
    telemetry.close();
    throw error;
  }
}

const workerpoolChannels = createWorkerpoolChannels();
const workerpoolRequestControlChannel = workerpoolChannels.requestControl;
const workerpoolTelemetryChannel = workerpoolChannels.telemetry;
const canceledWorkerpoolRequestIds = new Set<string>();

function debugLog(message: string, data?: Record<string, unknown>): void {
  void message;
  void data;
}

function warnLog(message: string, data?: Record<string, unknown>): void {
  // biome-ignore lint/suspicious/noConsole: Worker warnings surface high-signal runtime and telemetry inconsistencies.
  console.warn('[EmbeddingWorker]', message, data ?? '');
}

function errorLog(message: string, data?: Record<string, unknown>): void {
  // biome-ignore lint/suspicious/noConsole: Worker errors must surface when the worker hits unexpected global failures.
  console.error('[EmbeddingWorker]', message, data ?? '');
}

/** Request currently executing through workerpool; worker failures use this correlation id. */
let activeWorkerpoolRequestId: string | null = null;
/** Direct-stream requests currently executing; global failures notify each owning client. */
const activeStreamRequestIds = new Set<string>();
/** Idle workerpool failures quarantine this runtime synchronously until its owner replaces it. */
let workerLifetimeFailure: Error | null = null;

if (workerpoolRequestControlChannel && workerpoolTelemetryChannel) {
  workerpoolRequestControlChannel.onmessage = (event: MessageEvent<unknown>): void => {
    try {
      assertEmbedWorkerRequestControl(event.data);
      const control: EmbedWorkerRequestControl = event.data;
      if (control.type === 'cancel-request') {
        canceledWorkerpoolRequestIds.add(control.id);
      } else {
        canceledWorkerpoolRequestIds.delete(control.id);
      }
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      workerLifetimeFailure = new Error('Embedding worker request-control validation failed.', {
        cause: error,
      });
      workerpoolTelemetryChannel.postMessage({
        cause,
        message: workerLifetimeFailure.message,
        type: 'worker-lifetime-error',
        workerInstanceId: embeddingWorkerInstanceId,
      } satisfies EmbedWorkerLifetimeError);
    }
  };
}

function throwIfWorkerpoolRequestCanceled(id: string): void {
  if (!canceledWorkerpoolRequestIds.delete(id)) {
    return;
  }
  const error = new Error('Embedding task was aborted.');
  error.name = 'AbortError';
  throw error;
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError';
}

// Global error handlers - only set up in actual worker environment.
// This code only runs in browser Web Worker context where `self` exists.
// It cannot be tested in Node.js. Coverage is excluded via c8 ignore.
/* c8 ignore next 36 -- Worker globals only exist in browser Web Worker context */
if (typeof self !== 'undefined' && typeof self.onerror !== 'undefined') {
  const emitGlobalFailure = (message: string, cause?: string): boolean => {
    const workerpoolRequestId = activeWorkerpoolRequestId;
    workerEmit({
      cause,
      id: workerpoolRequestId ?? 'global',
      message,
      type: 'error',
    });
    for (const id of activeStreamRequestIds) {
      postStreamEvent({ cause, id, message, type: 'error' });
    }
    const activeOwnerWasNotified = workerpoolRequestId !== null || activeStreamRequestIds.size > 0;
    if (!activeOwnerWasNotified && workerpoolTelemetryChannel) {
      workerLifetimeFailure = new Error(
        'Embedding worker cannot accept work after an idle global failure.',
        { cause: cause ?? message }
      );
      workerpoolTelemetryChannel.postMessage({
        ...(cause === undefined ? {} : { cause }),
        message,
        type: 'worker-lifetime-error',
        workerInstanceId: embeddingWorkerInstanceId,
      } satisfies EmbedWorkerLifetimeError);
      return true;
    }
    if (activeOwnerWasNotified && typeof self.close === 'function') {
      self.close();
    }
    return activeOwnerWasNotified;
  };

  // Global error handler to catch any uncaught errors in the worker
  self.onerror = (event) => {
    const message = typeof event === 'string' ? event : (event as ErrorEvent).message;
    const filename = typeof event === 'object' ? (event as ErrorEvent).filename : undefined;
    const lineno = typeof event === 'object' ? (event as ErrorEvent).lineno : undefined;
    errorLog('Uncaught worker error', { event, filename, lineno, message });
    emitGlobalFailure(
      `Worker uncaught error: ${message}`,
      filename ? `${filename}:${lineno}` : undefined
    );
  };

  // Catch unhandled promise rejections
  self.onunhandledrejection = (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    errorLog('Unhandled worker promise rejection', { message, reason, stack });
    const ownerWasNotified = emitGlobalFailure(`Worker unhandled rejection: ${message}`, stack);
    if (!ownerWasNotified) {
      // Unlike an uncaught worker error, an unhandled rejection does not propagate to the
      // owning Worker. Re-report it as an uncaught error so workerpool/direct-client error
      // listeners visibly fail and retire this idle runtime before its next request.
      self.onerror = null;
      reportError(reason instanceof Error ? reason : new Error(message));
    }
  };

  // Log worker initialization at debug level (removed - too verbose)

  // Listen for power-state broadcasts from the renderer to pause/resume GPU
  // keep-alive during system suspend. BroadcastChannel works across same-origin
  // contexts (including web workers) without needing direct Worker references,
  // so this bypasses the workerpool abstraction cleanly.
  if (typeof BroadcastChannel !== 'undefined') {
    const powerChannel = new BroadcastChannel(POWER_BROADCAST_CHANNEL);
    powerChannel.onmessage = (event) => {
      if (event.data === 'suspend') {
        keepAlivePaused = true;
        debugLog('GPU keep-alive paused for system suspend');
      } else if (event.data === 'resume') {
        keepAlivePaused = false;
        debugLog('GPU keep-alive resumed after system resume');
      }
    };
  }
}

/**
 * FeatureExtractor pipeline callable type.
 *
 * Note: The FeatureExtractionPipeline._call() method only accepts these options.
 * Truncation is handled internally by the pipeline - it passes `truncation: true`
 * to the tokenizer automatically. The tokenizer uses the model's configured
 * `model_max_length` (e.g., 512 for MiniLM, 8192 for BGE-M3).
 *
 * See: https://huggingface.co/docs/transformers.js/api/pipelines#featureextractionpipeline
 */
type FeatureExtractor = FeatureExtractionPipeline &
  ((
    inputs: string | readonly string[],
    options?: {
      readonly pooling?: 'none' | 'mean' | 'cls';
      readonly normalize?: boolean;
      readonly quantize?: boolean;
      readonly precision?: 'binary' | 'ubinary';
    }
  ) => Promise<unknown>);

interface CatchableCleanup {
  catch: (onRejected: () => void) => unknown;
}

function isCatchableCleanup(value: unknown): value is CatchableCleanup {
  return (
    typeof value === 'object' &&
    value !== null &&
    'catch' in value &&
    typeof value.catch === 'function'
  );
}

function disposeFeatureExtractorBestEffort(extractor: FeatureExtractor): void {
  try {
    if (typeof extractor.dispose !== 'function') {
      return;
    }

    const cleanupResult = (extractor.dispose as () => unknown).call(extractor);
    if (!isCatchableCleanup(cleanupResult)) {
      return;
    }

    cleanupResult.catch(() => {});
  } catch {
    // Disposal must not mask the pipeline load failure that triggered cleanup.
  }
}

interface TransformersRuntime {
  readonly env: {
    allowRemoteModels?: boolean;
    backends?: { onnx?: { webgpu?: { device?: unknown } } };
  };
  readonly meanPooling?: (
    lastHiddenState: TransformersTensor,
    attentionMask: TransformersTensor
  ) => TransformersTensor;
  readonly pipeline: (
    task: 'feature-extraction',
    model: string,
    options: {
      readonly device: EmbeddingDevice;
      readonly dtype: EmbeddingDType;
      readonly revision?: string;
    }
  ) => Promise<FeatureExtractionPipeline>;
  readonly tensorConstructor: unknown;
}

function assertTransformersRuntime(value: unknown): TransformersRuntime {
  if (!(typeof value === 'object' && value !== null && !Array.isArray(value))) {
    throw new Error('Embedding worker test runtime must be an object.');
  }
  const candidate = value as Record<string, unknown>;
  const env = candidate['env'];
  if (
    !(typeof env === 'object' && env !== null && !Array.isArray(env)) ||
    typeof candidate['pipeline'] !== 'function' ||
    typeof candidate['tensorConstructor'] !== 'function'
  ) {
    throw new Error('Embedding worker test runtime is missing env, pipeline, or Tensor.');
  }
  if ((env as Record<string, unknown>)['allowRemoteModels'] !== false) {
    throw new Error('Embedding worker test runtime must disable remote models.');
  }
  return value as TransformersRuntime;
}

/**
 * Model context window reference (for documentation).
 *
 * These values represent the maximum sequence length each model can handle.
 * Truncation is handled automatically by the FeatureExtractionPipeline,
 * which passes `truncation: true` to the tokenizer internally. The tokenizer
 * uses the model's `model_max_length` from its configuration file.
 *
 * Common model context windows:
 * - MiniLM models: 512 tokens
 * - BGE-M3: 8192 tokens
 * - Jina models: 8192 tokens
 */

const testRuntimeOverride = consumeEmbeddingWorkerTestRuntimeOverride();
const webGpuClassProxyEnabled = testRuntimeOverride?.webGpuClassProxy === true;
let transformersRuntimePromise: Promise<TransformersRuntime> | null = testRuntimeOverride
  ? Promise.resolve(assertTransformersRuntime(testRuntimeOverride.runtime))
  : null;

async function getTransformersRuntime(): Promise<TransformersRuntime> {
  if (transformersRuntimePromise !== null) {
    return transformersRuntimePromise;
  }
  const runtimePromise: Promise<TransformersRuntime> = (async (): Promise<TransformersRuntime> => {
    try {
      const runtimeModule = await import('@huggingface/transformers');
      const runtime = runtimeModule as unknown as {
        env: TransformersRuntime['env'];
        pipeline: TransformersRuntime['pipeline'];
      };
      const tensorConstructor = Reflect.get(
        runtimeModule as object,
        'Tensor'
      ) as TransformersRuntime['tensorConstructor'];
      // Allow remote model downloads when a cache directory is not specified. This aligns with the
      // Transformers.js recommendation for browser deployments. Source: https://huggingface.co/docs/transformers.js/en/integrations/web
      runtime.env.allowRemoteModels = runtime.env.allowRemoteModels ?? true;
      return {
        env: runtime.env,
        meanPooling: (lastHiddenState, attentionMask) =>
          runtimeModule.mean_pooling(lastHiddenState, attentionMask),
        pipeline: runtime.pipeline,
        tensorConstructor,
      };
    } catch (error: unknown) {
      transformersRuntimePromise = null;
      throw error;
    }
  })();
  transformersRuntimePromise = runtimePromise;
  return runtimePromise;
}

// ---------------------------------------------------------------------------
// WebGPU device keep-alive & device loss recovery
//
// Problem:
//   ONNX Runtime Web acquires a GPUDevice internally when using the WebGPU
//   execution provider. If the Electron renderer is backgrounded (unfocused)
//   for ~5 minutes, Chromium freezes all JS timers. The GPU device then idles
//   out, and when ONNX Runtime next accesses the stale native handle it
//   triggers a V8 CHECK() assertion failure (SIGTRAP / exitCode 5), killing
//   the entire renderer process.
//
// Fix (three layers):
//   Layer 1 (root cause) — the hidden desktop embedding-host renderer uses
//     `backgroundThrottling: false` so Chromium never freezes that worker
//     host's timers while local embeddings are running.
//   Layer 2 (defence-in-depth) — this file's keep-alive submits a real GPU
//     command buffer every 15 s to register activity with the driver.
//   Layer 3 (recovery) — device-loss watcher terminates this worker cleanly
//     via self.close(); workerpool (minWorkers: 1) spawns a replacement.
//     create-window.ts also has a `render-process-gone` handler that reloads
//     the renderer if a crash still occurs.
//
// The ONNX Runtime device is accessible after the first inference session via
// `env.backends.onnx.webgpu.device` (a Promise<GPUDevice>).
//
// Full write-up: docs/debug-handoff-renderer-crash.md
//
// Refs:
//   - WebGPU spec device loss: https://gpuweb.github.io/gpuweb/#dom-gpudevice-lost
//   - ONNX Runtime env flags:  https://onnxruntime.ai/docs/api/js/interfaces/Env.WebGpuFlags.html
//   - Toji best practices:     https://toji.dev/webgpu-best-practices/device-loss.html
// ---------------------------------------------------------------------------

const GPU_KEEPALIVE_INTERVAL_MS = 15_000;

// Minimal WebGPU type surface used by the keep-alive / device-loss system.
// The full @webgpu/types package is not in this project's deps; these cover
// only the members we actually touch.
interface GpuDeviceLostInfo {
  readonly message: string;
  readonly reason: string | undefined;
}
interface GpuCommandBuffer {
  // Phantom field to avoid accidentally passing plain `{}` into queue.submit.
  readonly __brand: 'GPUCommandBuffer';
}
interface GpuCommandEncoder {
  finish: () => GpuCommandBuffer;
}
interface GpuQueue {
  submit: (buffers: GpuCommandBuffer[]) => void;
}
interface GpuDeviceHandle {
  createCommandEncoder: () => GpuCommandEncoder;
  readonly lost: Promise<GpuDeviceLostInfo>;
  readonly queue: GpuQueue;
}

/** Handle for the keep-alive interval so it can be stopped on device loss. */
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

/** When true, the keep-alive interval skips GPU command submissions.
 *  Set via 'pause-keepalive' / 'resume-keepalive' messages from the renderer
 *  during system suspend/resume to avoid submitting commands to a stale GPU device. */
let keepAlivePaused = false;

/** When true, an inference call is actively using the GPU device.
 *  The keep-alive skips its tick to avoid concurrent GPUQueue submissions
 *  that can race on the Metal command queue and trigger a Dawn CHECK(). */
let isInferenceActive = false;

/** Whether we have already attached the device-loss watcher for the current device. */
let deviceLossWatcherAttached = false;

/** Counter for diagnostic logging of keep-alive ticks. */
let keepAliveTickCount = 0;

const batchAckWaiters = new Map<string, () => void>();

function publishPipelineCacheDiagnostic(event: EmbedWorkerPipelineCacheDiagnostic): void {
  if (event.id === undefined) {
    if (workerpoolTelemetryChannel) {
      workerpoolTelemetryChannel.postMessage(event);
    } else {
      // Streaming workers do not carry a workerpool channel. Their owning client listens
      // directly for worker-global diagnostics after the request-scoped stream has settled.
      postStreamEvent(event);
    }
    return;
  }
  workerEmit(event);
}

const pipelineCacheController = createEmbeddingPipelineCacheController<FeatureExtractor>({
  isIdleSweepAllowed: () => !isInferenceActive,
  load: createFeatureExtractor,
  onDisposed: ({ cacheKey }) => {
    debugLog('Disposed cached pipeline', { cacheKey });
  },
  onDisposeFailed: ({ cacheKey, error, reason }) => {
    const cause = error instanceof Error ? error.message : String(error);
    const message = `Embedding pipeline disposal failed for ${cacheKey} (${reason}).`;
    errorLog(message, { cause });
    if (workerpoolTelemetryChannel) {
      workerpoolTelemetryChannel.postMessage({
        cause,
        message,
        type: 'worker-lifetime-error',
        workerInstanceId: embeddingWorkerInstanceId,
      } satisfies EmbedWorkerLifetimeError);
      return;
    }
    reportError(new Error(message, { cause: error }));
  },
  onLoadFailed: ({ device, dtype, error, model }) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    debugLog('Pipeline load failed', { device, dtype, error: errorMessage, model, stack });
  },
  onModelSizeEstimateMismatch: ({ cachedBytes, cacheKey, requestedBytes }) => {
    warnLog(
      'Embedding model size metadata changed for a cached pipeline; keeping the original estimate',
      { cachedBytes, cacheKey, requestedBytes }
    );
  },
  onResidencyChanged: updateKeepAliveState,
  publishDiagnostic: publishPipelineCacheDiagnostic,
  workerInstanceId: embeddingWorkerInstanceId,
});

function buildAckKey(id: string, batchIndex: number): string {
  return `${id}:${batchIndex}`;
}

function waitForBatchAck(id: string, batchIndex: number): Promise<void> {
  return new Promise<void>((resolve) => {
    batchAckWaiters.set(buildAckKey(id, batchIndex), resolve);
  });
}

function acknowledgeBatch(id: string, batchIndex: number): void {
  const key = buildAckKey(id, batchIndex);
  const resolve = batchAckWaiters.get(key);
  if (!resolve) {
    return;
  }
  batchAckWaiters.delete(key);
  resolve();
}

/**
 * Obtain the GPUDevice that ONNX Runtime created internally.
 *
 * After the first WebGPU inference session, ONNX Runtime freezes the device
 * onto `env.webgpu.device` via Object.defineProperty (writable: false,
 * configurable: false). Transformers.js exposes the ORT env at
 * `env.backends.onnx`, so the device lives at `env.backends.onnx.webgpu.device`.
 *
 * Returns `null` if WebGPU is not in use or the device is unavailable.
 */
async function getOrtWebGpuDevice(): Promise<GpuDeviceHandle | null> {
  try {
    const runtime = await getTransformersRuntime();
    const onnxEnv = runtime.env.backends?.onnx as
      | { webgpu?: { device: Promise<GpuDeviceHandle> | GpuDeviceHandle } }
      | undefined;
    if (!onnxEnv?.webgpu) {
      debugLog('GPU guard skipped because env.backends.onnx.webgpu is unavailable');
      return null;
    }
    const device = await onnxEnv.webgpu.device;
    if (!device || typeof device.createCommandEncoder !== 'function') {
      debugLog('GPU guard skipped because device is missing or invalid', {
        hasDevice: Boolean(device),
        type: typeof device,
      });
      return null;
    }
    return device;
  } catch (error) {
    debugLog('GPU guard could not acquire device', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Start periodic GPU command submissions to keep the device alive.
 *
 * Chromium / the OS GPU driver may reclaim a WebGPU device after an extended
 * idle period. We submit a real (but empty) command buffer — not just
 * `queue.submit([])` which may be optimised away — to register actual GPU
 * activity with the driver.
 *
 * Safe to call multiple times — only one interval runs at a time.
 */
function startKeepAlive(device: GpuDeviceHandle): void {
  if (keepAliveTimer !== null) {
    return;
  }
  debugLog('GPU keep-alive started', { intervalMs: GPU_KEEPALIVE_INTERVAL_MS });
  keepAliveTimer = setInterval(() => {
    if (keepAlivePaused || isInferenceActive) {
      return;
    }
    try {
      // Create and submit a real (empty) command buffer. This goes through
      // Dawn's full command-buffer encoding and submission path, which is
      // more likely to be treated as genuine GPU activity by the driver
      // than a bare `queue.submit([])`.
      const encoder = device.createCommandEncoder();
      device.queue.submit([encoder.finish()]);
      keepAliveTickCount += 1;
      // Log periodically (every ~2 min) to confirm the keep-alive is running.
      // `=== 1` intentionally logs the first tick immediately, then every 8 ticks.
      if (keepAliveTickCount % 8 === 1) {
        debugLog('GPU keep-alive tick', { tick: keepAliveTickCount });
      }
    } catch (error) {
      debugLog('GPU keep-alive tick failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Device may already be lost; the device-loss watcher handles cleanup.
      stopKeepAlive();
    }
  }, GPU_KEEPALIVE_INTERVAL_MS);
}

function stopKeepAlive(): void {
  if (keepAliveTimer !== null) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    debugLog('GPU keep-alive stopped');
  }
}

/**
 * Invalidate all cached pipelines that were loaded with a WebGPU device.
 * The next embed() call will call loadPipeline() which recreates the pipeline
 * (and ONNX Runtime will acquire a fresh GPUDevice internally).
 *
 * NOTE: ONNX Runtime freezes `env.webgpu.device` with configurable: false,
 * so a fresh device can only be obtained in a new worker instance. The
 * pipeline invalidation is still useful as a signal, but true recovery
 * requires workerpool to restart this worker (which it does automatically
 * when minWorkers >= 1).
 */
function invalidateWebGpuPipelines(): void {
  const residentGpuCount = pipelineCacheController
    .getResidentEntries()
    .filter((entry) => entry.device === 'webgpu').length;
  pipelineCacheController.invalidateWebGpuPipelines();
  debugLog('Invalidated cached WebGPU pipelines', { count: residentGpuCount });
}

function updateKeepAliveState(): void {
  if (!pipelineCacheController.hasResidentDevice('webgpu')) {
    stopKeepAlive();
  }
}

/**
 * Attach a one-time watcher on GPUDevice.lost. When device loss fires:
 *   1. Stop the keep-alive interval (the device is gone).
 *   2. Invalidate all WebGPU pipeline cache entries.
 *   3. Terminate this worker so workerpool can spawn a fresh one.
 *
 * Self-termination is necessary because ONNX Runtime's WebGPU backend is a
 * one-shot singleton — `env.webgpu.device` is frozen (configurable: false)
 * and cannot be replaced. A new device can only exist in a new worker.
 * Calling `self.close()` terminates cleanly (no SIGTRAP), and workerpool's
 * `minWorkers: 1` ensures a replacement is spawned immediately.
 */
function watchDeviceLoss(device: GpuDeviceHandle): void {
  if (deviceLossWatcherAttached) {
    return;
  }
  deviceLossWatcherAttached = true;

  void device.lost.then((info: GpuDeviceLostInfo) => {
    const workerpoolRequestId = activeWorkerpoolRequestId;
    const hasActiveRequests = workerpoolRequestId !== null || activeStreamRequestIds.size > 0;
    if (hasActiveRequests) {
      warnLog('WebGPU device lost', { message: info.message, reason: info.reason });
    } else {
      debugLog('Idle WebGPU device lost', { message: info.message, reason: info.reason });
    }

    stopKeepAlive();
    invalidateWebGpuPipelines();
    deviceLossWatcherAttached = false;

    if (workerpoolRequestId !== null) {
      workerEmit({
        cause: `reason=${String(info.reason)}`,
        id: workerpoolRequestId,
        message: `WebGPU device lost: ${info.message}`,
        type: 'error',
      });
    }
    if (activeStreamRequestIds.size > 0) {
      notifyActiveStreamsOfDeviceLoss(info);
    }

    // Terminate this worker cleanly. Workerpool will spawn a fresh one
    // (minWorkers: 1) which can acquire a new GPUDevice.
    // Any in-flight request rejects and is expected to be retried by the
    // embedding queue's existing retry path.
    if (hasActiveRequests) {
      warnLog('Terminating worker after WebGPU device loss for clean recovery');
    }
    workerpoolTelemetryChannel?.postMessage({
      reason: 'device-lost',
      type: 'telemetry-source-closed',
      workerInstanceId: embeddingWorkerInstanceId,
    } satisfies EmbedWorkerTelemetrySourceClosed);
    if (typeof self !== 'undefined' && typeof self.close === 'function') {
      self.close();
    }
  });
}

/**
 * After a WebGPU pipeline successfully loads, set up the keep-alive heartbeat
 * and device-loss watcher on the ONNX Runtime device.
 */
async function initWebGpuDeviceGuard(): Promise<void> {
  const device = await getOrtWebGpuDevice();
  if (!device) {
    throw new Error('WebGPU pipeline loaded without a usable ORT WebGPU device');
  }
  debugLog('GPU guard acquired device and attached keep-alive plus loss watcher');
  startKeepAlive(device);
  watchDeviceLoss(device);
}

function hasWebGPU(): boolean {
  return (
    webGpuClassProxyEnabled ||
    (typeof navigator !== 'undefined' &&
      typeof (navigator as Navigator & { gpu?: unknown }).gpu !== 'undefined')
  );
}

function inferDevice(hint: EmbeddingDeviceHint | undefined): EmbeddingDevice {
  if (!hint) {
    throw new Error('Embedding deviceHint is required.');
  }
  if (hint === 'webgpu') {
    if (!hasWebGPU()) {
      throw new Error('WebGPU is not available in this environment.');
    }
    return 'webgpu';
  }
  return 'wasm';
}

async function createFeatureExtractor(
  model: string,
  device: EmbeddingDevice,
  dtype: EmbeddingDType,
  revision?: string
): Promise<FeatureExtractor> {
  const runtime = await getTransformersRuntime();
  const result = await runtime.pipeline('feature-extraction', model, {
    device,
    dtype,
    ...(revision === undefined ? {} : { revision }),
  });

  if (device !== 'webgpu') {
    return result as FeatureExtractor;
  }

  try {
    await initWebGpuDeviceGuard();
  } catch (guardError) {
    disposeFeatureExtractorBestEffort(result as FeatureExtractor);
    throw guardError;
  }

  return result as FeatureExtractor;
}

async function loadPipeline(
  model: string,
  device: EmbeddingDevice,
  dtype: EmbeddingDType,
  estimatedModelBytes: number | null,
  diagnostics: {
    readonly id?: string;
    readonly sink?: PipelineCacheDiagnosticSink;
  } = {},
  revision?: string
): Promise<FeatureExtractor> {
  debugLog('Loading pipeline', { device, dtype, model });
  return pipelineCacheController.load({
    device,
    diagnostics,
    dtype,
    estimatedModelBytes,
    model,
    ...(revision === undefined ? {} : { revision }),
  });
}

function assertValidDimension(payload: EmbedWorkerRequest, requestedDimension: number): void {
  if (!Number.isFinite(requestedDimension) || requestedDimension <= 0) {
    const providerLabel = payload.provider ? `Provider "${payload.provider}"` : 'Embedding request';
    const parameterHint =
      payload.dimensionParameter === 'dimensions'
        ? 'Set a positive integer via the dimensions parameter.'
        : payload.dimensionParameter === 'output_dimensionality'
          ? 'Set a positive integer via the output_dimensionality parameter.'
          : payload.dimensionParameter === 'output_dimension'
            ? 'Set a positive integer via the output_dimension parameter.'
            : 'Provide a positive integer targetDimension.';
    throw new Error(
      `${providerLabel} supplied an invalid target dimension (${requestedDimension}). ${parameterHint}`
    );
  }

  if (!Number.isInteger(requestedDimension)) {
    throw new Error(
      `targetDimension must be an integer, received ${requestedDimension} for model ${payload.model}.`
    );
  }

  if (requestedDimension > MAX_EMBEDDING_DIMENSION) {
    throw new Error(
      `targetDimension ${requestedDimension} exceeds pgvector's supported maximum of ${MAX_EMBEDDING_DIMENSION} dimensions.`
    );
  }
}

/**
 * Convert a Tensor from the pipeline output into normalized Float32Array vectors.
 * Handles 1D, 2D (batch), and arbitrarily nested tensor structures.
 */
function convertTensorToVectors(tensor: TransformersTensor, truncateDim?: number): Float32Array[] {
  const dims = tensor.dims;
  const data = tensor.data as ArrayLike<number>;
  if (dims.length === 1) {
    const vec = cloneAsFloat32(data);
    return [truncateVector(l2Normalize(vec, vec), truncateDim)];
  }
  if (dims.length === 2) {
    const [batch, width] = dims as [number, number];
    const typed = cloneAsFloat32(data);
    const vectors: Float32Array[] = [];
    for (let row = 0; row < batch; row += 1) {
      const start = row * width;
      const slice = typed.subarray(start, start + width);
      // Create a copy because subarray() returns a view into the original buffer.
      // l2Normalize modifies in-place, so without this copy we'd corrupt `typed`.
      const vec = new Float32Array(slice);
      l2Normalize(vec, vec);
      vectors.push(truncateVector(vec, truncateDim));
    }
    return vectors;
  }
  const flattened = Float32Array.from(tensor.tolist().flat(Number.POSITIVE_INFINITY) as number[]);
  return [truncateVector(l2Normalize(flattened, flattened), truncateDim)];
}

function isTransformersTensor(
  value: unknown,
  runtime: TransformersRuntime
): value is TransformersTensor {
  const tensorConstructor = runtime.tensorConstructor as abstract new (
    ...args: never[]
  ) => TransformersTensor;
  return value instanceof tensorConstructor;
}

interface EmbeddingContext {
  readonly dimensionParameter?: 'dimensions' | 'output_dimensionality' | 'output_dimension';
  readonly dtype: EmbeddingDType;
  readonly estimatedModelBytes: number | null;
  readonly id: string;
  readonly model: string;
  readonly provider?: string;
  readonly revision?: string;
  readonly started: number;
  readonly targetDimension?: number;
  readonly texts: readonly string[];
  readonly total: number;
  readonly truncateDim?: number;
}

interface EmbeddingState {
  batchSize: number;
  device: EmbeddingDevice;
  fallbackApplied: boolean;
  readonly maxBatchSize?: number;
}

function createContext(payload: EmbedWorkerRequest): EmbeddingContext {
  if (
    payload.revision !== undefined &&
    !(typeof payload.revision === 'string' && payload.revision.length > 0)
  ) {
    throw new Error('Embedding worker revision must be a non-empty string.');
  }
  const requestedDimension = payload.targetDimension ?? DEFAULT_EMBEDDING_DIMENSION;
  const estimatedModelBytes = payload.estimatedModelBytes ?? null;
  if (
    estimatedModelBytes !== null &&
    !(Number.isSafeInteger(estimatedModelBytes) && estimatedModelBytes > 0)
  ) {
    throw new Error(
      `estimatedModelBytes must be a positive safe integer, received ${String(payload.estimatedModelBytes)}.`
    );
  }
  const context: EmbeddingContext = {
    dtype: payload.dtype ?? 'fp16',
    estimatedModelBytes,
    id: payload.id,
    model: payload.model,
    ...(payload.revision === undefined ? {} : { revision: payload.revision }),
    started: typeof performance === 'undefined' ? Date.now() : performance.now(),
    targetDimension: requestedDimension,
    texts: payload.texts,
    total: payload.texts.length,
  };
  if (payload.truncateDim !== undefined) {
    (context as { truncateDim?: number }).truncateDim = payload.truncateDim;
  } else if (Number.isFinite(requestedDimension)) {
    (context as { truncateDim?: number }).truncateDim = requestedDimension;
  }
  if (payload.provider) {
    (context as { provider?: string }).provider = payload.provider;
  }
  if (payload.dimensionParameter) {
    (
      context as {
        dimensionParameter?: 'dimensions' | 'output_dimensionality' | 'output_dimension';
      }
    ).dimensionParameter = payload.dimensionParameter;
  }
  return context;
}

function createInitialState(
  context: EmbeddingContext,
  deviceHint: EmbeddingDeviceHint,
  maxBatchSize: number | undefined
): EmbeddingState {
  return {
    batchSize: computeInitialBatchSize(context.total, maxBatchSize),
    device: inferDevice(deviceHint),
    fallbackApplied: false,
    ...(maxBatchSize === undefined ? {} : { maxBatchSize }),
  };
}

async function embed(payload: EmbedWorkerRequest): Promise<EmbedWorkerSuccess> {
  if (workerLifetimeFailure !== null) {
    throw workerLifetimeFailure;
  }
  const context = createContext(payload);
  const { id, model, texts } = context;
  throwIfWorkerpoolRequestCanceled(id);
  const deviceHint = payload.deviceHint;
  const requestedDimension = context.targetDimension ?? DEFAULT_EMBEDDING_DIMENSION;
  assertValidDimension(payload, requestedDimension);

  if (texts.length === 0) {
    return {
      id,
      metadata: {
        batchSize: 0,
        device: inferDevice(deviceHint),
        dimensions: context.truncateDim ?? 0,
        dtype: context.dtype,
        elapsedMs: 0,
        fallbackApplied: false,
        model,
        ...(context.revision === undefined ? {} : { revision: context.revision }),
      },
      type: 'result',
      vectors: [],
    };
  }

  workerEmit({
    id,
    phase: 'initializing',
    progress: 0,
    type: 'progress',
  });

  const state = createInitialState(context, deviceHint, payload.maxBatchSize);
  isInferenceActive = true;
  activeWorkerpoolRequestId = context.id;
  try {
    const result = await processEmbeddings(context, state);
    return result;
  } catch (error) {
    if (!isAbortError(error)) {
      emitErrorEvent(context.id, error);
    }
    // Always throw a proper Error object so workerpool can serialize it correctly
    throw normalizeError(error);
  } finally {
    canceledWorkerpoolRequestIds.delete(id);
    activeWorkerpoolRequestId = null;
    isInferenceActive = false;
  }
}

async function processEmbeddings(
  context: EmbeddingContext,
  state: EmbeddingState
): Promise<EmbedWorkerSuccess> {
  const extractor = await loadPipeline(
    context.model,
    state.device,
    context.dtype,
    context.estimatedModelBytes,
    { id: context.id },
    context.revision
  );
  throwIfWorkerpoolRequestCanceled(context.id);
  const vectors = await runBatches(context, state, extractor);
  throwIfWorkerpoolRequestCanceled(context.id);
  if (vectors.length === 0) {
    return buildSuccessResult(context, state, vectors);
  }
  const packed = packVectorsContiguous(vectors);
  const success = buildSuccessResult(context, state, packed.vectors);
  return new Transfer(success, packed.transferList) as unknown as EmbedWorkerSuccess;
}

/**
 * Pack a list of per-vector `Float32Array`s into a single contiguous buffer
 * so the worker can transfer just one `ArrayBuffer` to the host (BST-90).
 *
 * The returned `vectors` are subarray *views* into the shared buffer — same
 * shape `Float32Array[]`, same numeric values, but only one transfer entry.
 * If the input vectors have uneven lengths (e.g. mixed truncation), the pack
 * is skipped and the original arrays are returned with their own buffers as
 * a defensive fallback.
 */
function getTransferableBuffers(vectors: readonly Float32Array[]): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  const seen = new Set<ArrayBuffer>();
  for (const vector of vectors) {
    const buffer = vector.buffer;
    if (!(buffer instanceof ArrayBuffer) || seen.has(buffer)) {
      continue;
    }
    seen.add(buffer);
    buffers.push(buffer);
  }
  return buffers;
}

function packVectorsContiguous(vectors: readonly Float32Array[]): {
  transferList: ArrayBuffer[];
  vectors: Float32Array[];
} {
  const first = vectors[0];
  if (!first) {
    return { transferList: [], vectors: [] };
  }
  const dim = first.length;
  for (const vector of vectors) {
    if (vector.length !== dim) {
      // Uneven dimensions shouldn't happen in normal flows, but fall back
      // to per-vector buffers rather than silently dropping dimensions.
      return {
        transferList: getTransferableBuffers(vectors),
        vectors: vectors.slice(),
      };
    }
  }
  const flat = new Float32Array(vectors.length * dim);
  for (let i = 0; i < vectors.length; i += 1) {
    const vector = vectors[i];
    if (vector) {
      flat.set(vector, i * dim);
    }
  }
  const views: Float32Array[] = [];
  for (let i = 0; i < vectors.length; i += 1) {
    views.push(flat.subarray(i * dim, (i + 1) * dim));
  }
  return { transferList: [flat.buffer], vectors: views };
}

function postStreamEvent(
  event:
    | EmbedWorkerBatch
    | EmbedWorkerComplete
    | EmbedWorkerError
    | EmbedWorkerPipelineCacheDiagnostic
    | EmbedWorkerProgress,
  transferList?: Transferable[]
): void {
  if (typeof self === 'undefined' || typeof self.postMessage !== 'function') {
    return;
  }
  self.postMessage(event, transferList ?? []);
}

function notifyActiveStreamsOfDeviceLoss(info: GpuDeviceLostInfo): void {
  for (const id of activeStreamRequestIds) {
    postStreamEvent({
      cause: `reason=${String(info.reason)}`,
      id,
      message: `WebGPU device lost: ${info.message}`,
      type: 'error',
    });
  }
}

async function streamEmbeddings(context: EmbeddingContext, state: EmbeddingState): Promise<void> {
  const { texts, truncateDim, id, total } = context;
  const started = typeof performance === 'undefined' ? Date.now() : performance.now();

  postStreamEvent({
    id,
    phase: 'initializing',
    progress: 0,
    type: 'progress',
  });

  const extractor = await loadPipeline(
    context.model,
    state.device,
    context.dtype,
    context.estimatedModelBytes,
    {
      id: context.id,
      sink: postStreamEvent,
    },
    context.revision
  );
  const runtime = await getTransformersRuntime();
  let batchIndex = 0;
  let dimensions = context.truncateDim ?? 0;
  let peakVectorsInFlight = 0;
  let startIndex = 0;
  for (const endIndex of createBatchEnds(context, state, extractor)) {
    const slice = texts.slice(startIndex, endIndex);
    const rawOutput = await extractBatch(context, extractor, slice, runtime);
    const vectorsFromBatch = isTransformersTensor(rawOutput, runtime)
      ? convertTensorToVectors(rawOutput, truncateDim)
      : vectorsFromPipelineOutput(rawOutput, truncateDim);
    // Dispose the output tensor to release its GPU buffer reference.
    if (isTransformersTensor(rawOutput, runtime) && typeof rawOutput.dispose === 'function') {
      rawOutput.dispose();
    }
    if (vectorsFromBatch.length === 0) {
      throw new Error('Embedding pipeline returned no tensors');
    }
    dimensions = vectorsFromBatch[0]?.length ?? dimensions;

    const transferList = getTransferableBuffers(vectorsFromBatch);
    const transferBytes = transferList.reduce(
      (totalBytes, buffer) => totalBytes + buffer.byteLength,
      0
    );
    const vectorsInFlight = vectorsFromBatch.length;
    peakVectorsInFlight = Math.max(peakVectorsInFlight, vectorsInFlight);
    postStreamEvent(
      {
        batchIndex,
        endIndex,
        id,
        peakVectorsInFlight,
        startIndex,
        transferBytes,
        type: 'batch',
        vectors: vectorsFromBatch,
        vectorsInFlight,
      },
      transferList
    );

    postStreamEvent({
      id,
      phase: 'embedding',
      progress: normalizeProgress(endIndex / total),
      type: 'progress',
    });

    await waitForBatchAck(id, batchIndex);
    batchIndex += 1;
    startIndex = endIndex;
  }

  const finished = typeof performance === 'undefined' ? Date.now() : performance.now();
  postStreamEvent({
    id,
    metadata: {
      batchSize: state.batchSize,
      device: state.device,
      dimensions,
      dtype: context.dtype,
      elapsedMs: finished - started,
      fallbackApplied: state.fallbackApplied,
      model: context.model,
      ...(context.revision === undefined ? {} : { revision: context.revision }),
    },
    type: 'complete',
  });
}

async function runBatches(
  context: EmbeddingContext,
  state: EmbeddingState,
  extractor: FeatureExtractor
): Promise<Float32Array[]> {
  const vectors: Float32Array[] = [];
  const { texts, truncateDim, id, total } = context;
  const runtime = await getTransformersRuntime();

  let startIndex = 0;
  for (const endIndex of createBatchEnds(context, state, extractor)) {
    throwIfWorkerpoolRequestCanceled(id);
    const slice = texts.slice(startIndex, endIndex);
    const rawOutput = await extractBatch(context, extractor, slice, runtime);
    const vectorsFromBatch = isTransformersTensor(rawOutput, runtime)
      ? convertTensorToVectors(rawOutput, truncateDim)
      : vectorsFromPipelineOutput(rawOutput, truncateDim);
    // Dispose the output tensor to release the underlying WebGPU/GPU buffer.
    if (isTransformersTensor(rawOutput, runtime) && typeof rawOutput.dispose === 'function') {
      rawOutput.dispose();
    }
    throwIfWorkerpoolRequestCanceled(id);
    if (vectorsFromBatch.length === 0) {
      throw new Error('Embedding pipeline returned no tensors');
    }
    for (const vector of vectorsFromBatch) {
      vectors.push(vector);
    }

    workerEmit({
      id,
      phase: 'embedding',
      progress: normalizeProgress(endIndex / total),
      type: 'progress',
    });
    startIndex = endIndex;
  }

  return vectors;
}

function createBatchEnds(
  context: EmbeddingContext,
  state: EmbeddingState,
  extractor: FeatureExtractor
): number[] {
  if (context.model === FUSED_MINILM_MODEL_ID) {
    const ends = createTokenBudgetBatchEnds(context.texts, extractor.tokenizer, state.batchSize);
    let start = 0;
    state.batchSize = 0;
    for (const end of ends) {
      state.batchSize = Math.max(state.batchSize, end - start);
      start = end;
    }
    return ends;
  }
  const ends: number[] = [];
  for (let start = 0; start < context.total; start += state.batchSize) {
    ends.push(Math.min(context.total, start + state.batchSize));
  }
  return ends;
}

function extractBatch(
  context: EmbeddingContext,
  extractor: FeatureExtractor,
  texts: readonly string[],
  runtime: TransformersRuntime
): Promise<unknown> {
  if (context.model !== FUSED_MINILM_MODEL_ID) {
    return extractor(texts, { normalize: false, pooling: 'mean' });
  }
  if (!runtime.meanPooling) {
    throw new Error('Fused MiniLM requires the Transformers.js mean_pooling API.');
  }
  return extractCappedEmbeddings(extractor, texts, runtime.meanPooling);
}

function buildSuccessResult(
  context: EmbeddingContext,
  state: EmbeddingState,
  vectors: Float32Array[]
): EmbedWorkerSuccess {
  const finished = typeof performance === 'undefined' ? Date.now() : performance.now();
  workerEmit({
    id: context.id,
    phase: 'complete',
    progress: 1,
    type: 'progress',
  });

  return {
    id: context.id,
    metadata: {
      batchSize: state.batchSize,
      device: state.device,
      dimensions: vectors[0]?.length ?? context.truncateDim ?? 0,
      dtype: context.dtype,
      elapsedMs: finished - context.started,
      fallbackApplied: state.fallbackApplied,
      model: context.model,
      ...(context.revision === undefined ? {} : { revision: context.revision }),
    },
    type: 'result',
    vectors,
  };
}

function serializeErrorCause(error: unknown): string | undefined {
  if (error === undefined || error === null) {
    return;
  }
  if (error instanceof Error) {
    // Include stack trace if available for debugging
    return error.stack ?? error.message;
  }
  // Handle raw numeric error codes (e.g., from ONNX runtime)
  if (typeof error === 'number') {
    return `Error code: ${error} (0x${error.toString(16)})`;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Normalize any error value to a proper Error object.
 * This ensures workerpool can serialize and transmit errors correctly.
 * Raw values (numbers, undefined) from ONNX/WASM are wrapped with context.
 */
function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (error === undefined || error === null) {
    return new Error('Embedding failed with unknown error (no details available)');
  }
  if (typeof error === 'number') {
    return new Error(`Embedding failed with error code: ${error} (0x${error.toString(16)})`);
  }
  if (typeof error === 'string') {
    return new Error(error);
  }
  try {
    return new Error(`Embedding failed: ${JSON.stringify(error)}`);
  } catch {
    return new Error(`Embedding failed: ${String(error)}`);
  }
}

function emitErrorEvent(id: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const event: EmbedWorkerError = {
    cause: serializeErrorCause(error),
    id,
    message,
    type: 'error',
  };
  workerEmit(event);
}

worker({
  // Workerpool exposes the `workerEmit` helper for streaming progress back to the main thread.
  // Source: https://github.com/josdejong/workerpool#progress
  runEmbedding: embed,
});

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data as {
      batchIndex?: unknown;
      id?: unknown;
      request?: unknown;
      type?: unknown;
    };
    if (message.type === 'stream-ack') {
      if (typeof message.id === 'string' && typeof message.batchIndex === 'number') {
        acknowledgeBatch(message.id, message.batchIndex);
      }
      return;
    }
    if (message.type !== 'stream-embed') {
      return;
    }
    const request = message.request;
    if (!request || typeof request !== 'object') {
      postStreamEvent({
        id: 'unknown',
        message: 'Streaming request payload must be an object.',
        type: 'error',
      });
      return;
    }

    const payload = request as EmbedWorkerRequest;
    const requestId =
      typeof payload.id === 'string' && payload.id.length > 0 ? payload.id : 'unknown';
    void (async () => {
      let context: EmbeddingContext | null = null;
      try {
        context = createContext(payload);
        activeStreamRequestIds.add(context.id);
        const requestedDimension = context.targetDimension ?? DEFAULT_EMBEDDING_DIMENSION;
        assertValidDimension(payload, requestedDimension);
        const state = createInitialState(context, payload.deviceHint, payload.maxBatchSize);
        isInferenceActive = true;
        await streamEmbeddings(context, state);
      } catch (error) {
        postStreamEvent({
          cause: serializeErrorCause(error),
          id: context?.id ?? requestId,
          message: error instanceof Error ? error.message : String(error),
          type: 'error',
        });
      } finally {
        if (context !== null) {
          activeStreamRequestIds.delete(context.id);
        }
        isInferenceActive = false;
      }
    })();
  });
}
