/// <reference lib="webworker" />

import { DEFAULT_EMBEDDING_DIMENSION, MAX_EMBEDDING_DIMENSION } from '@brainstrike/types';
import type {
  FeatureExtractionPipeline,
  Tensor as TransformersTensor,
} from '@huggingface/transformers';
import { Transfer, worker, workerEmit } from 'workerpool';
import type {
  EmbeddingDevice,
  EmbeddingDeviceHint,
  EmbeddingDType,
  EmbedWorkerBatch,
  EmbedWorkerComplete,
  EmbedWorkerError,
  EmbedWorkerPipelineCacheDiagnostic,
  EmbedWorkerPipelineCacheEntryDiagnostic,
  EmbedWorkerProgress,
  EmbedWorkerRequest,
  EmbedWorkerSuccess,
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

function debugLog(message: string, data?: Record<string, unknown>): void {
  void message;
  void data;
}

function warnLog(message: string, data?: Record<string, unknown>): void {
  // biome-ignore lint/suspicious/noConsole: Worker warnings are only surfaced for high-signal device-loss paths.
  console.warn('[EmbeddingWorker]', message, data ?? '');
}

function errorLog(message: string, data?: Record<string, unknown>): void {
  // biome-ignore lint/suspicious/noConsole: Worker errors must surface when the worker hits unexpected global failures.
  console.error('[EmbeddingWorker]', message, data ?? '');
}

// Global error handlers - only set up in actual worker environment.
// This code only runs in browser Web Worker context where `self` exists.
// It cannot be tested in Node.js. Coverage is excluded via c8 ignore.
/* c8 ignore next 36 -- Worker globals only exist in browser Web Worker context */
if (typeof self !== 'undefined' && typeof self.onerror !== 'undefined') {
  // Global error handler to catch any uncaught errors in the worker
  self.onerror = (event) => {
    const message = typeof event === 'string' ? event : (event as ErrorEvent).message;
    const filename = typeof event === 'object' ? (event as ErrorEvent).filename : undefined;
    const lineno = typeof event === 'object' ? (event as ErrorEvent).lineno : undefined;
    errorLog('Uncaught worker error', { message, filename, lineno, event });
    workerEmit({
      type: 'error',
      id: 'global',
      message: `Worker uncaught error: ${message}`,
      cause: filename ? `${filename}:${lineno}` : undefined,
    });
  };

  // Catch unhandled promise rejections
  self.onunhandledrejection = (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    errorLog('Unhandled worker promise rejection', { message, stack, reason });
    workerEmit({
      type: 'error',
      id: 'global',
      message: `Worker unhandled rejection: ${message}`,
      cause: stack,
    });
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
  catch(onRejected: () => void): unknown;
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

interface PipelineCacheEntry {
  readonly cacheKey: string;
  /** Monotonic timestamp (via `now()`) — reserved for future diagnostics. */
  readonly createdAt: number;
  readonly device: EmbeddingDevice;
  readonly dtype: EmbeddingDType;
  lastUsedAt: number;
  readonly model: string;
  readonly pipeline: Promise<FeatureExtractor>;
}

interface TransformersRuntime {
  readonly env: {
    allowRemoteModels?: boolean;
    backends?: { onnx?: { webgpu?: { device?: unknown } } };
  };
  readonly pipeline: (
    task: 'feature-extraction',
    model: string,
    options: {
      readonly device: EmbeddingDevice;
      readonly dtype: EmbeddingDType;
    }
  ) => Promise<FeatureExtractionPipeline>;
  readonly tensorConstructor: unknown;
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

const pipelines = new Map<string, PipelineCacheEntry>();
let transformersRuntimePromise: Promise<TransformersRuntime> | null = null;

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

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());

const MAX_GPU_PIPELINES = 1;
const MAX_WASM_PIPELINES = 3;
const PIPELINE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = 30_000;

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
  finish(): GpuCommandBuffer;
}
interface GpuQueue {
  submit(buffers: GpuCommandBuffer[]): void;
}
interface GpuDeviceHandle {
  createCommandEncoder(): GpuCommandEncoder;
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

/** Handle for the idle-sweep interval. */
let idleSweepTimer: ReturnType<typeof setInterval> | null = null;
const batchAckWaiters = new Map<string, () => void>();

type PipelineCacheDisposalReason = NonNullable<EmbedWorkerPipelineCacheDiagnostic['reason']>;

type PipelineCacheDiagnosticSink = (event: EmbedWorkerPipelineCacheDiagnostic) => void;

interface PipelineCacheDiagnosticOptions {
  readonly entry?: PipelineCacheEntry;
  readonly event: EmbedWorkerPipelineCacheDiagnostic['event'];
  readonly id?: string;
  readonly reason?: PipelineCacheDisposalReason;
  readonly sink?: PipelineCacheDiagnosticSink;
}

const UNAVAILABLE_PIPELINE_MEMORY = {
  gpuBytes: null,
  heapBytes: null,
  reason: 'browser-runtime-unavailable',
} as const;

function toPipelineCacheEntryDiagnostic(
  entry: PipelineCacheEntry,
  timestamp: number
): EmbedWorkerPipelineCacheEntryDiagnostic {
  return {
    cacheKey: entry.cacheKey,
    createdAt: entry.createdAt,
    device: entry.device,
    dtype: entry.dtype,
    lastUsedAt: entry.lastUsedAt,
    memory: UNAVAILABLE_PIPELINE_MEMORY,
    model: entry.model,
    residencyMs: Math.max(0, timestamp - entry.createdAt),
  };
}

function buildPipelineCacheEntryDiagnostics(
  timestamp: number
): EmbedWorkerPipelineCacheEntryDiagnostic[] {
  return [...pipelines.values()].map((entry) => toPipelineCacheEntryDiagnostic(entry, timestamp));
}

function shouldIncludePipelineCacheEntries(
  event: EmbedWorkerPipelineCacheDiagnostic['event']
): boolean {
  return event !== 'hit';
}

function emitPipelineCacheDiagnostic(options: PipelineCacheDiagnosticOptions): void {
  const timestamp = now();
  const entryDiagnostic =
    options.entry === undefined
      ? undefined
      : toPipelineCacheEntryDiagnostic(options.entry, timestamp);
  const event: EmbedWorkerPipelineCacheDiagnostic = {
    type: 'diagnostic',
    diagnostic: 'pipeline-cache',
    event: options.event,
    emittedAt: timestamp,
    cacheSize: pipelines.size,
    ...(shouldIncludePipelineCacheEntries(options.event)
      ? { entries: buildPipelineCacheEntryDiagnostics(timestamp) }
      : {}),
    ...(entryDiagnostic === undefined ? {} : { entry: entryDiagnostic }),
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  };

  if (options.sink) {
    options.sink(event);
    return;
  }
  workerEmit(event);
}

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
async function disposePipeline(
  key: string,
  diagnostics: {
    readonly event?: 'disposed' | 'evicted';
    readonly id?: string;
    readonly reason?: PipelineCacheDisposalReason;
    readonly sink?: PipelineCacheDiagnosticSink;
  } = {}
): Promise<void> {
  const entry = pipelines.get(key);
  if (!entry) {
    return;
  }
  // Delete from cache FIRST to prevent concurrent access during async dispose
  pipelines.delete(key);
  emitPipelineCacheDiagnostic({
    entry,
    event: diagnostics.event ?? 'disposed',
    ...(diagnostics.id === undefined ? {} : { id: diagnostics.id }),
    reason: diagnostics.reason ?? 'manual-dispose',
    ...(diagnostics.sink === undefined ? {} : { sink: diagnostics.sink }),
  });
  try {
    const p = await entry.pipeline;
    if (typeof p.dispose === 'function') {
      p.dispose();
    }
  } catch {
    // Pipeline load may have failed — nothing to dispose
  }
  debugLog('Disposed cached pipeline', { cacheKey: key });
  updateKeepAliveState();
  if (pipelines.size === 0) {
    stopIdleSweep();
  }
}

function invalidateWebGpuPipelines(): void {
  const keysToDispose: string[] = [];
  for (const [key, entry] of pipelines) {
    if (entry.device === 'webgpu') {
      keysToDispose.push(key);
    }
  }
  for (const key of keysToDispose) {
    // Device-loss invalidation is global worker telemetry, not scoped to any active stream sink.
    void disposePipeline(key, { event: 'evicted', reason: 'device-lost' });
  }
  debugLog('Invalidated cached WebGPU pipelines', { count: keysToDispose.length });
  emitPipelineCacheDiagnostic({
    event: 'invalidated',
    reason: 'device-lost',
  });
}

function evictLruByDevice(
  device: EmbeddingDevice,
  maxResident: number,
  diagnostics: {
    readonly id?: string;
    readonly sink?: PipelineCacheDiagnosticSink;
  } = {}
): void {
  const entries: PipelineCacheEntry[] = [];
  for (const entry of pipelines.values()) {
    if (entry.device === device) {
      entries.push(entry);
    }
  }
  if (entries.length < maxResident) {
    return;
  }
  // Sort oldest-first by lastUsedAt
  entries.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  const evictCount = entries.length - maxResident + 1;
  for (let i = 0; i < evictCount; i++) {
    const victim = entries[i];
    if (victim) {
      void disposePipeline(victim.cacheKey, {
        event: 'evicted',
        ...(diagnostics.id === undefined ? {} : { id: diagnostics.id }),
        reason: 'resident-limit',
        ...(diagnostics.sink === undefined ? {} : { sink: diagnostics.sink }),
      });
    }
  }
}

function sweepIdlePipelines(): void {
  if (isInferenceActive) {
    return;
  }
  const cutoff = now() - PIPELINE_IDLE_TIMEOUT_MS;
  const keysToEvict: string[] = [];
  for (const [key, entry] of pipelines) {
    if (entry.lastUsedAt < cutoff) {
      keysToEvict.push(key);
    }
  }
  for (const key of keysToEvict) {
    void disposePipeline(key, { event: 'evicted', reason: 'idle-timeout' });
  }
  if (keysToEvict.length > 0) {
    updateKeepAliveState();
  }
}

function startIdleSweep(): void {
  if (idleSweepTimer !== null) {
    return;
  }
  idleSweepTimer = setInterval(sweepIdlePipelines, IDLE_SWEEP_INTERVAL_MS);
}

function stopIdleSweep(): void {
  if (idleSweepTimer !== null) {
    clearInterval(idleSweepTimer);
    idleSweepTimer = null;
  }
}

function updateKeepAliveState(): void {
  let hasGpu = false;
  for (const entry of pipelines.values()) {
    if (entry.device === 'webgpu') {
      hasGpu = true;
      break;
    }
  }
  if (!hasGpu) {
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
    warnLog('WebGPU device lost', { message: info.message, reason: info.reason });

    stopKeepAlive();
    invalidateWebGpuPipelines();
    deviceLossWatcherAttached = false;

    workerEmit({
      type: 'error',
      id: 'device-lost',
      message: `WebGPU device lost: ${info.message}`,
      cause: `reason=${String(info.reason)}`,
    });

    // Terminate this worker cleanly. Workerpool will spawn a fresh one
    // (minWorkers: 1) which can acquire a new GPUDevice.
    // Any in-flight request rejects and is expected to be retried by the
    // embedding queue's existing retry path.
    warnLog('Terminating worker after WebGPU device loss for clean recovery');
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
    typeof navigator !== 'undefined' &&
    typeof (navigator as Navigator & { gpu?: unknown }).gpu !== 'undefined'
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
  dtype: EmbeddingDType
): Promise<FeatureExtractor> {
  const runtime = await getTransformersRuntime();
  const result = await runtime.pipeline('feature-extraction', model, { device, dtype });

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

function handlePipelineLoadFailure(
  cacheKey: string,
  model: string,
  device: EmbeddingDevice,
  dtype: EmbeddingDType,
  diagnostics: {
    readonly id?: string;
    readonly sink?: PipelineCacheDiagnosticSink;
  },
  error: unknown
): void {
  const failedEntry = pipelines.get(cacheKey);
  pipelines.delete(cacheKey);
  emitPipelineCacheDiagnostic({
    ...(failedEntry === undefined ? {} : { entry: failedEntry }),
    event: 'load-failed',
    ...(diagnostics.id === undefined ? {} : { id: diagnostics.id }),
    reason: 'load-failure',
    ...(diagnostics.sink === undefined ? {} : { sink: diagnostics.sink }),
  });

  const errorMsg = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;
  debugLog('Pipeline load failed', {
    model,
    device,
    dtype,
    error: errorMsg,
    stack: errorStack,
  });
}

async function loadPipeline(
  model: string,
  device: EmbeddingDevice,
  dtype: EmbeddingDType,
  diagnostics: {
    readonly id?: string;
    readonly sink?: PipelineCacheDiagnosticSink;
  } = {}
): Promise<FeatureExtractor> {
  const cacheKey = `${model}|${device}|${dtype}`;
  const existing = pipelines.get(cacheKey);
  if (existing !== undefined) {
    existing.lastUsedAt = now();
    emitPipelineCacheDiagnostic({
      entry: existing,
      event: 'hit',
      ...(diagnostics.id === undefined ? {} : { id: diagnostics.id }),
      ...(diagnostics.sink === undefined ? {} : { sink: diagnostics.sink }),
    });
    return existing.pipeline;
  }

  debugLog('Loading pipeline', { model, device, dtype });

  let entry!: PipelineCacheEntry;
  const loader = (async () => {
    try {
      // createFeatureExtractor is async and yields before this continuation reads `entry`.
      // The cache entry is assigned and registered synchronously below before that read can run.
      const extractor = await createFeatureExtractor(model, device, dtype);
      if (pipelines.get(cacheKey) === entry) {
        emitPipelineCacheDiagnostic({
          entry,
          event: 'loaded',
          ...(diagnostics.id === undefined ? {} : { id: diagnostics.id }),
          ...(diagnostics.sink === undefined ? {} : { sink: diagnostics.sink }),
        });
      }
      return extractor;
    } catch (error) {
      handlePipelineLoadFailure(cacheKey, model, device, dtype, diagnostics, error);
      throw error;
    }
  })();

  const maxResident = device === 'webgpu' ? MAX_GPU_PIPELINES : MAX_WASM_PIPELINES;
  evictLruByDevice(device, maxResident, diagnostics);

  const timestamp = now();
  entry = {
    cacheKey,
    pipeline: loader,
    device,
    dtype,
    model,
    lastUsedAt: timestamp,
    createdAt: timestamp,
  };
  pipelines.set(cacheKey, entry);
  startIdleSweep();

  return loader;
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
  readonly id: string;
  readonly model: string;
  readonly provider?: string;
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
  const requestedDimension = payload.targetDimension ?? DEFAULT_EMBEDDING_DIMENSION;
  const context: EmbeddingContext = {
    id: payload.id,
    model: payload.model,
    texts: payload.texts,
    dtype: payload.dtype ?? 'fp16',
    started: typeof performance === 'undefined' ? Date.now() : performance.now(),
    total: payload.texts.length,
    targetDimension: requestedDimension,
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
    device: inferDevice(deviceHint),
    batchSize: computeInitialBatchSize(context.total, maxBatchSize),
    fallbackApplied: false,
    ...(maxBatchSize === undefined ? {} : { maxBatchSize }),
  };
}

async function embed(payload: EmbedWorkerRequest): Promise<EmbedWorkerSuccess> {
  const context = createContext(payload);
  const { id, model, texts } = context;
  const deviceHint = payload.deviceHint;
  const requestedDimension = context.targetDimension ?? DEFAULT_EMBEDDING_DIMENSION;
  assertValidDimension(payload, requestedDimension);

  if (texts.length === 0) {
    return {
      type: 'result',
      id,
      vectors: [],
      metadata: {
        model,
        device: inferDevice(deviceHint),
        dtype: context.dtype,
        batchSize: 0,
        elapsedMs: 0,
        fallbackApplied: false,
        dimensions: context.truncateDim ?? 0,
      },
    };
  }

  workerEmit({
    type: 'progress',
    id,
    progress: 0,
    phase: 'initializing',
  });

  const state = createInitialState(context, deviceHint, payload.maxBatchSize);
  isInferenceActive = true;
  try {
    const result = await processEmbeddings(context, state);
    return result;
  } catch (error) {
    emitErrorEvent(context.id, error);
    // Always throw a proper Error object so workerpool can serialize it correctly
    throw normalizeError(error);
  } finally {
    isInferenceActive = false;
  }
}

async function processEmbeddings(
  context: EmbeddingContext,
  state: EmbeddingState
): Promise<EmbedWorkerSuccess> {
  const extractor = await loadPipeline(context.model, state.device, context.dtype, {
    id: context.id,
  });
  const vectors = await runBatches(context, state, extractor);
  const success = buildSuccessResult(context, state, vectors);
  if (vectors.length === 0) {
    return success;
  }
  const transferList = vectors.map((vector) => vector.buffer);
  return new Transfer(success, transferList) as unknown as EmbedWorkerSuccess;
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

async function streamEmbeddings(context: EmbeddingContext, state: EmbeddingState): Promise<void> {
  const { texts, truncateDim, id, total } = context;
  const started = typeof performance === 'undefined' ? Date.now() : performance.now();

  postStreamEvent({
    type: 'progress',
    id,
    progress: 0,
    phase: 'initializing',
  });

  const extractor = await loadPipeline(context.model, state.device, context.dtype, {
    id: context.id,
    sink: postStreamEvent,
  });
  const runtime = await getTransformersRuntime();
  let batchIndex = 0;
  let dimensions = context.truncateDim ?? 0;
  for (let startIndex = 0; startIndex < total; startIndex += state.batchSize) {
    const endIndex = Math.min(total, startIndex + state.batchSize);
    const slice = texts.slice(startIndex, endIndex);
    const rawOutput = await extractor(slice, {
      pooling: 'mean',
      normalize: false,
    });
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

    postStreamEvent(
      {
        type: 'batch',
        id,
        batchIndex,
        startIndex,
        endIndex,
        vectors: vectorsFromBatch,
      },
      vectorsFromBatch.map((vector) => vector.buffer)
    );

    postStreamEvent({
      type: 'progress',
      id,
      phase: 'embedding',
      progress: normalizeProgress(endIndex / total),
    });

    await waitForBatchAck(id, batchIndex);
    batchIndex += 1;
  }

  const finished = typeof performance === 'undefined' ? Date.now() : performance.now();
  postStreamEvent({
    type: 'complete',
    id,
    metadata: {
      model: context.model,
      device: state.device,
      dtype: context.dtype,
      batchSize: state.batchSize,
      elapsedMs: finished - started,
      fallbackApplied: state.fallbackApplied,
      dimensions,
    },
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

  for (let startIndex = 0; startIndex < total; startIndex += state.batchSize) {
    const endIndex = Math.min(total, startIndex + state.batchSize);
    const slice = texts.slice(startIndex, endIndex);
    // Truncation is handled internally by FeatureExtractionPipeline - it passes
    // `truncation: true` to the tokenizer automatically. The tokenizer respects
    // the model's configured `model_max_length` to prevent ONNX/WASM crashes.
    const rawOutput = await extractor(slice, {
      pooling: 'mean',
      normalize: false,
    });
    const vectorsFromBatch = isTransformersTensor(rawOutput, runtime)
      ? convertTensorToVectors(rawOutput, truncateDim)
      : vectorsFromPipelineOutput(rawOutput, truncateDim);
    // Dispose the output tensor to release the underlying WebGPU/GPU buffer.
    if (isTransformersTensor(rawOutput, runtime) && typeof rawOutput.dispose === 'function') {
      rawOutput.dispose();
    }
    if (vectorsFromBatch.length === 0) {
      throw new Error('Embedding pipeline returned no tensors');
    }
    for (const vector of vectorsFromBatch) {
      vectors.push(vector);
    }

    workerEmit({
      type: 'progress',
      id,
      phase: 'embedding',
      progress: normalizeProgress(endIndex / total),
    });
  }

  return vectors;
}

function buildSuccessResult(
  context: EmbeddingContext,
  state: EmbeddingState,
  vectors: Float32Array[]
): EmbedWorkerSuccess {
  const finished = typeof performance === 'undefined' ? Date.now() : performance.now();
  workerEmit({
    type: 'progress',
    id: context.id,
    phase: 'complete',
    progress: 1,
  });

  return {
    type: 'result',
    id: context.id,
    vectors,
    metadata: {
      model: context.model,
      device: state.device,
      dtype: context.dtype,
      batchSize: state.batchSize,
      elapsedMs: finished - context.started,
      fallbackApplied: state.fallbackApplied,
      dimensions: vectors[0]?.length ?? context.truncateDim ?? 0,
    },
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
    type: 'error',
    id,
    message,
    cause: serializeErrorCause(error),
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
        type: 'error',
        id: 'unknown',
        message: 'Streaming request payload must be an object.',
      });
      return;
    }

    const payload = request as EmbedWorkerRequest;
    void (async () => {
      const context = createContext(payload);
      const requestedDimension = context.targetDimension ?? DEFAULT_EMBEDDING_DIMENSION;
      assertValidDimension(payload, requestedDimension);
      const state = createInitialState(context, payload.deviceHint, payload.maxBatchSize);
      isInferenceActive = true;
      try {
        await streamEmbeddings(context, state);
      } catch (error) {
        postStreamEvent({
          type: 'error',
          id: context.id,
          message: error instanceof Error ? error.message : String(error),
          cause: serializeErrorCause(error),
        });
      } finally {
        isInferenceActive = false;
      }
    })();
  });
}
