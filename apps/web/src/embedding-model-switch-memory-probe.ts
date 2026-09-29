import {
  type EmbedWorkerBatch,
  type EmbedWorkerPipelineCacheDiagnostic,
  embeddingWorkerTelemetrySink,
  getEmbeddingTelemetrySnapshot,
} from '@brainstrike/embedding-worker';
import { createBrowserEmbeddingQueue } from '@brainstrike/queue/browser';
import {
  readExclusiveProbeWorkerMemory,
  readMemoryMeasurement,
} from './embedding-model-switch-memory-measurement';
import embeddingModelSwitchMemoryProbeWorkerUrl from './embedding-model-switch-memory-probe.worker.ts?worker&url';
import {
  assertEmbeddingModelSwitchMemoryProbeWorkerMessage,
  BST369_E2E_INIT_FLAG,
  BST369_GPU_MODEL_BYTES,
  BST369_MAX_LIVE_BYTES,
  BST369_PROBE_AUTOMATION_FRAGMENT_KEY,
  BST369_PROBE_AUTOMATION_TOKEN,
  BST369_PROBE_CHANNEL_FRAGMENT_KEY,
  BST369_WARM_GPU_MODELS,
  BST369_WARM_WASM_MODELS,
  BST369_WASM_MODEL_BYTES,
  BST369_WINDOW_A_GPU_MODELS,
  BST369_WINDOW_A_WASM_MODELS,
  BST369_WINDOW_B_GPU_MODELS,
  BST369_WINDOW_B_WASM_MODELS,
  type EmbeddingModelSwitchAgentMemorySample,
  type EmbeddingModelSwitchMemoryBarrier,
  type EmbeddingModelSwitchMemoryProbeSummary,
  type EmbeddingModelSwitchMemoryProbeWorkerMessage,
  type EmbeddingModelSwitchPhysicalState,
  type WebE2EEmbeddingModelSwitchMemoryProbeResult,
} from './embedding-model-switch-memory-probe-contract';

const PROBE_TIMEOUT_MS = 30_000;
const EXPECTED_TRANSFER_BYTES = 4 * Float32Array.BYTES_PER_ELEMENT;

function markProbeProgress(label: string): void {
  performance.mark(`bst-369:${label}`);
}

interface ProbeTelemetry {
  readonly evictions: readonly EmbedWorkerPipelineCacheDiagnostic[];
  readonly failureReasons: readonly string[];
  readonly sink: typeof embeddingWorkerTelemetrySink;
  readonly sourceIds: ReadonlySet<string>;
  readonly sourceRemoved: () => boolean;
  readonly transferBytes: () => number;
  readonly transferEventCount: () => number;
}

async function readAgentMemory(
  label: EmbeddingModelSwitchAgentMemorySample['label']
): Promise<EmbeddingModelSwitchAgentMemorySample> {
  if (globalThis.crossOriginIsolated !== true) {
    throw new Error('BST-369 memory measurement requires cross-origin isolation.');
  }
  const candidate = Reflect.get(performance, 'measureUserAgentSpecificMemory');
  if (typeof candidate !== 'function') {
    throw new Error('BST-369 requires performance.measureUserAgentSpecificMemory().');
  }
  const measurement = readMemoryMeasurement(await candidate.call(performance));
  const workerMemory = readExclusiveProbeWorkerMemory(measurement);
  return {
    label,
    totalBytes: measurement.bytes,
    ...workerMemory,
  };
}

async function requireWorkerAttribution(
  label: EmbeddingModelSwitchAgentMemorySample['label'],
  expected: 'absent' | 'present'
): Promise<EmbeddingModelSwitchAgentMemorySample> {
  let lastSample: EmbeddingModelSwitchAgentMemorySample | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    lastSample = await readAgentMemory(label);
    const present = lastSample.workerBreakdownCount > 0;
    if ((expected === 'present' && present) || (expected === 'absent' && !present)) {
      return lastSample;
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  throw new Error(
    `BST-369 expected probe worker attribution ${expected}; last sample=${JSON.stringify(lastSample)}.`
  );
}

async function waitForWorkerTerminationCommit(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function createProbeTelemetry(): ProbeTelemetry {
  const evictions: EmbedWorkerPipelineCacheDiagnostic[] = [];
  const failureReasons: string[] = [];
  const sourceIds = new Set<string>();
  let sourceRemoved = false;
  let transferBytes = 0;
  let transferEventCount = 0;
  return {
    evictions,
    failureReasons,
    sink: {
      recordBatch: (sourceId: string, event: EmbedWorkerBatch): void => {
        sourceIds.add(sourceId);
        transferEventCount += 1;
        transferBytes += event.transferBytes;
        embeddingWorkerTelemetrySink.recordBatch(sourceId, event);
      },
      recordFailure: (reason: string): void => {
        failureReasons.push(reason);
        embeddingWorkerTelemetrySink.recordFailure(reason);
      },
      recordPipelineCache: (sourceId: string, event: EmbedWorkerPipelineCacheDiagnostic): void => {
        sourceIds.add(sourceId);
        if (event.event === 'evicted' && event.reason === 'resident-limit') {
          evictions.push(event);
        }
        embeddingWorkerTelemetrySink.recordPipelineCache(sourceId, event);
      },
      removeSource: (sourceId: string): void => {
        if (sourceIds.has(sourceId)) {
          sourceRemoved = true;
        }
        embeddingWorkerTelemetrySink.removeSource(sourceId);
      },
    },
    sourceIds,
    sourceRemoved: () => sourceRemoved,
    transferBytes: () => transferBytes,
    transferEventCount: () => transferEventCount,
  };
}

function createPhysicalStateReader(channelName: string): {
  readonly close: () => void;
  readonly waitForReady: () => Promise<void>;
  readonly waitForState: (
    barrier: EmbeddingModelSwitchMemoryBarrier,
    allocationCount: number,
    disposalCount: number
  ) => Promise<EmbeddingModelSwitchPhysicalState>;
} {
  const channel = new BroadcastChannel(channelName);
  const listeners = new Set<() => void>();
  let ready = false;
  let state: EmbeddingModelSwitchPhysicalState | null = null;
  let terminalError: Error | null = null;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };
  channel.onmessage = (event: MessageEvent<unknown>): void => {
    try {
      assertEmbeddingModelSwitchMemoryProbeWorkerMessage(event.data);
      const message: EmbeddingModelSwitchMemoryProbeWorkerMessage = event.data;
      if (message.type === 'error') {
        markProbeProgress('worker-error');
        terminalError = new Error(`BST-369 production worker wrapper failed: ${message.message}`);
      } else if (message.type === 'ready') {
        markProbeProgress('worker-ready');
        ready = true;
      } else {
        markProbeProgress(`physical-${message.allocationCount}-${message.disposedModels.length}`);
        const uniqueDisposed = new Set(message.disposedModels);
        if (uniqueDisposed.size !== message.disposedModels.length) {
          throw new Error('BST-369 physical ledger reported duplicate disposal.');
        }
        if (message.liveBytes > BST369_MAX_LIVE_BYTES || message.residentModels.length > 4) {
          throw new Error(
            `BST-369 physical residency exceeded its bound: ${JSON.stringify(message)}.`
          );
        }
        state = {
          allocationCount: message.allocationCount,
          disposedModels: [...message.disposedModels],
          liveBytes: message.liveBytes,
          residentModels: [...message.residentModels],
        };
      }
    } catch (error) {
      terminalError = error instanceof Error ? error : new Error(String(error));
    }
    notify();
  };
  channel.onmessageerror = (): void => {
    terminalError = new Error('BST-369 physical ledger emitted an unreadable message.');
    notify();
  };

  const waitFor = async (description: string, predicate: () => boolean): Promise<void> => {
    if (terminalError) {
      throw terminalError;
    }
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`BST-369 timed out waiting for ${description}.`));
      }, PROBE_TIMEOUT_MS);
      const check = (): void => {
        if (terminalError) {
          window.clearTimeout(timeout);
          listeners.delete(check);
          reject(terminalError);
          return;
        }
        if (!predicate()) {
          return;
        }
        window.clearTimeout(timeout);
        listeners.delete(check);
        resolve();
      };
      listeners.add(check);
    });
  };

  return {
    close: () => channel.close(),
    waitForReady: async () => await waitFor('production worker readiness', () => ready),
    waitForState: async (barrier, allocationCount, disposalCount) => {
      await waitFor(
        `${barrier} physical state`,
        () =>
          state?.allocationCount === allocationCount &&
          state.disposedModels.length === disposalCount
      );
      if (!state) {
        throw new Error(`BST-369 ${barrier} state disappeared after its barrier.`);
      }
      return {
        allocationCount: state.allocationCount,
        disposedModels: [...state.disposedModels],
        liveBytes: state.liveBytes,
        residentModels: [...state.residentModels],
      };
    },
  };
}

function summarizeTelemetry(
  sourceIds: ReadonlySet<string>
): EmbeddingModelSwitchMemoryProbeSummary {
  let estimatedGpuBytes = 0;
  let estimatedHeapBytes = 0;
  let memoryEstimateUnavailableCount = 0;
  let residentCount = 0;
  for (const entry of getEmbeddingTelemetrySnapshot().cache.entries) {
    if (!sourceIds.has(entry.sourceId)) {
      continue;
    }
    residentCount += 1;
    estimatedGpuBytes += entry.memory.gpuBytes ?? 0;
    estimatedHeapBytes += entry.memory.heapBytes ?? 0;
    if (entry.memory.gpuBytes === null && entry.memory.heapBytes === null) {
      memoryEstimateUnavailableCount += 1;
    }
  }
  return {
    estimatedGpuBytes,
    estimatedHeapBytes,
    memoryEstimateUnavailableCount,
    residentCount,
  };
}

function requireFirstEvictedModel(
  evictions: readonly EmbedWorkerPipelineCacheDiagnostic[],
  device: 'wasm' | 'webgpu'
): string {
  const model = evictions.find((event) => event.entry?.device === device)?.entry?.model;
  if (!model) {
    throw new Error(`BST-369 emitted no ${device} resident-limit eviction.`);
  }
  return model;
}

async function runModels(
  queue: ReturnType<typeof createBrowserEmbeddingQueue>,
  models: readonly string[],
  device: 'wasm' | 'webgpu'
): Promise<void> {
  for (const model of models) {
    markProbeProgress(`task-${model}-start`);
    const id = `bst-369-${crypto.randomUUID()}`;
    const dtype = device === 'wasm' ? 'q4' : 'fp16';
    const result = await queue.add({
      deviceHint: device,
      dtype,
      estimatedModelBytes: device === 'wasm' ? BST369_WASM_MODEL_BYTES : BST369_GPU_MODEL_BYTES,
      id,
      kind: 'embed',
      maxBatchSize: 1,
      model,
      targetDimension: 4,
      texts: ['bst-369-memory-probe'],
      truncateDim: 4,
    });
    if (
      result.id !== id ||
      result.metadata.model !== model ||
      result.metadata.device !== device ||
      result.metadata.dtype !== dtype ||
      result.metadata.dimensions !== 4 ||
      result.vectors.length !== 1 ||
      result.vectors[0]?.byteLength !== EXPECTED_TRANSFER_BYTES
    ) {
      throw new Error(`BST-369 production embedding result drifted for ${model}.`);
    }
    markProbeProgress(`task-${model}-complete`);
  }
}

export async function runEmbeddingModelSwitchMemoryProbe(): Promise<WebE2EEmbeddingModelSwitchMemoryProbeResult> {
  if (window.navigator.webdriver !== true) {
    throw new Error('Embedding model-switch memory probe is restricted to webdriver automation.');
  }
  if (Reflect.get(window, BST369_E2E_INIT_FLAG) !== true) {
    throw new Error('Embedding model-switch memory probe requires the explicit init-script flag.');
  }

  markProbeProgress('baseline-start');
  const baseline = await requireWorkerAttribution('baseline', 'absent');
  markProbeProgress('baseline-complete');
  const channelName = `brainstrike-bst369-probe:${crypto.randomUUID()}`;
  const physicalStateReader = createPhysicalStateReader(channelName);
  const telemetry = createProbeTelemetry();
  const workerUrl = new URL(embeddingModelSwitchMemoryProbeWorkerUrl, window.location.href);
  workerUrl.hash = new URLSearchParams({
    [BST369_PROBE_AUTOMATION_FRAGMENT_KEY]: BST369_PROBE_AUTOMATION_TOKEN,
    [BST369_PROBE_CHANNEL_FRAGMENT_KEY]: channelName,
  }).toString();
  const queue = createBrowserEmbeddingQueue({
    requireWorkerpool: true,
    worker: {
      maxWorkers: 1,
      minWorkers: 1,
      name: 'BST-369 production worker memory probe',
      telemetry: telemetry.sink,
      workerUrl: workerUrl.href,
    },
  });
  if (typeof queue.dispose !== 'function') {
    physicalStateReader.close();
    throw new Error('BST-369 production embedding queue requires explicit disposal.');
  }
  const disposeQueue = queue.dispose;
  let disposed = false;
  try {
    markProbeProgress('warm-start');
    const warmRun = Promise.all([
      runModels(queue, BST369_WARM_WASM_MODELS, 'wasm'),
      physicalStateReader.waitForReady(),
    ]);
    await warmRun;
    await runModels(queue, BST369_WARM_GPU_MODELS, 'webgpu');
    const warmPhysical = await physicalStateReader.waitForState('warm', 6, 2);
    const warmMemory = await requireWorkerAttribution('warm', 'present');
    markProbeProgress('warm-complete');

    markProbeProgress('window-a-start');
    await runModels(queue, BST369_WINDOW_A_WASM_MODELS, 'wasm');
    await runModels(queue, BST369_WINDOW_A_GPU_MODELS, 'webgpu');
    const windowAPhysical = await physicalStateReader.waitForState('window-a', 14, 10);
    const windowAMemory = await requireWorkerAttribution('window-a', 'present');
    markProbeProgress('window-a-complete');

    markProbeProgress('window-b-start');
    await runModels(queue, BST369_WINDOW_B_WASM_MODELS, 'wasm');
    await runModels(queue, BST369_WINDOW_B_GPU_MODELS, 'webgpu');
    const windowBPhysical = await physicalStateReader.waitForState('window-b', 22, 18);
    const windowBMemory = await requireWorkerAttribution('window-b', 'present');
    markProbeProgress('window-b-complete');
    const beforeTeardown = summarizeTelemetry(telemetry.sourceIds);

    markProbeProgress('dispose-start');
    await disposeQueue();
    markProbeProgress('dispose-complete');
    disposed = true;
    await waitForWorkerTerminationCommit();
    markProbeProgress('teardown-memory-start');
    const afterTeardownMemory = await requireWorkerAttribution('after-teardown', 'absent');
    markProbeProgress('teardown-complete');
    const afterTeardown = summarizeTelemetry(telemetry.sourceIds);

    return {
      afterTeardown: {
        estimatedGpuBytes: afterTeardown.estimatedGpuBytes,
        estimatedHeapBytes: afterTeardown.estimatedHeapBytes,
        residentCount: afterTeardown.residentCount,
      },
      beforeTeardown,
      failureReasons: [...telemetry.failureReasons],
      firstGpuEvictedModel: requireFirstEvictedModel(telemetry.evictions, 'webgpu'),
      firstWasmEvictedModel: requireFirstEvictedModel(telemetry.evictions, 'wasm'),
      memory: {
        afterTeardown: afterTeardownMemory,
        baseline,
        warm: warmMemory,
        windowA: windowAMemory,
        windowB: windowBMemory,
      },
      physical: {
        warm: warmPhysical,
        windowA: windowAPhysical,
        windowB: windowBPhysical,
      },
      residentLimitEvictionCount: telemetry.evictions.length,
      telemetrySourceRemoved: telemetry.sourceRemoved(),
      transferBytes: telemetry.transferBytes(),
      transferEventCount: telemetry.transferEventCount(),
    };
  } finally {
    physicalStateReader.close();
    if (!disposed) {
      await disposeQueue();
    }
  }
}
