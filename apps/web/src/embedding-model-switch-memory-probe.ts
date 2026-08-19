import {
  type EmbeddingTelemetrySnapshot,
  type EmbedWorkerPipelineCacheDiagnostic,
  getEmbeddingTelemetrySnapshot,
  recordEmbeddingPipelineCacheTelemetry,
  removeEmbeddingTelemetrySource,
} from '@brainstrike/embedding-worker';
import {
  assertEmbeddingModelSwitchMemoryProbeWorkerMessage,
  type EmbeddingModelSwitchMemoryProbeRequest,
  type EmbeddingModelSwitchMemoryProbeSummary,
  type EmbeddingModelSwitchMemoryProbeWorkerMessage,
  type WebE2EEmbeddingModelSwitchMemoryProbeResult,
} from './embedding-model-switch-memory-probe-contract';

const PROBE_TIMEOUT_MS = 15_000;

function summarizeSource(
  snapshot: EmbeddingTelemetrySnapshot,
  sourceId: string
): EmbeddingModelSwitchMemoryProbeSummary {
  let estimatedGpuBytes = 0;
  let estimatedHeapBytes = 0;
  let memoryEstimateUnavailableCount = 0;
  let residentCount = 0;
  for (const entry of snapshot.cache.entries) {
    if (entry.sourceId !== sourceId) {
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
    throw new Error(`Embedding model-switch probe emitted no ${device} resident-limit eviction.`);
  }
  return model;
}

async function runWorkerProbe(
  worker: Worker,
  sourceId: string
): Promise<{
  readonly beforeTeardown: EmbeddingModelSwitchMemoryProbeSummary;
  readonly disposedModels: readonly string[];
  readonly evictions: readonly EmbedWorkerPipelineCacheDiagnostic[];
}> {
  return await new Promise((resolve, reject) => {
    const evictions: EmbedWorkerPipelineCacheDiagnostic[] = [];
    let beforeTeardown: EmbeddingModelSwitchMemoryProbeSummary | null = null;
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`Embedding model-switch probe timed out after ${PROBE_TIMEOUT_MS}ms.`));
    }, PROBE_TIMEOUT_MS);
    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      reject(error);
    };
    const resolveOnce = (disposedModels: readonly string[]): void => {
      if (settled) {
        return;
      }
      if (beforeTeardown === null) {
        rejectOnce(
          new Error('Embedding model-switch probe completed without a resident-state marker.')
        );
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      resolve({ beforeTeardown, disposedModels, evictions });
    };
    const recordDiagnostic = (diagnostic: EmbedWorkerPipelineCacheDiagnostic): void => {
      if (diagnostic.workerInstanceId !== sourceId) {
        throw new Error('Embedding model-switch probe diagnostic source identity drifted.');
      }
      recordEmbeddingPipelineCacheTelemetry(sourceId, diagnostic);
      if (diagnostic.event === 'evicted' && diagnostic.reason === 'resident-limit') {
        evictions.push(diagnostic);
      }
    };
    const handleMessage = (message: EmbeddingModelSwitchMemoryProbeWorkerMessage): void => {
      if (message.type === 'error') {
        rejectOnce(new Error(`Embedding model-switch probe failed: ${message.message}`));
        return;
      }
      if (message.type === 'diagnostic') {
        recordDiagnostic(message.diagnostic);
        return;
      }
      if (message.type === 'resident-state') {
        if (beforeTeardown !== null) {
          rejectOnce(new Error('Embedding model-switch probe emitted duplicate resident state.'));
          return;
        }
        beforeTeardown = summarizeSource(getEmbeddingTelemetrySnapshot(), sourceId);
        return;
      }
      resolveOnce(message.disposedModels);
    };

    worker.onerror = (event): void => {
      event.preventDefault();
      rejectOnce(new Error(`Embedding model-switch probe worker failed: ${event.message}`));
    };
    worker.onmessageerror = (): void => {
      rejectOnce(new Error('Embedding model-switch probe worker emitted an unreadable message.'));
    };
    worker.onmessage = (event: MessageEvent<unknown>): void => {
      try {
        assertEmbeddingModelSwitchMemoryProbeWorkerMessage(event.data);
        handleMessage(event.data);
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
      }
    };

    worker.postMessage({
      sourceId,
      type: 'run',
    } satisfies EmbeddingModelSwitchMemoryProbeRequest);
  });
}

export async function runEmbeddingModelSwitchMemoryProbe(): Promise<WebE2EEmbeddingModelSwitchMemoryProbeResult> {
  if (window.navigator.webdriver !== true) {
    throw new Error('Embedding model-switch memory probe is restricted to webdriver automation.');
  }

  const sourceId = `bst-369-probe-${crypto.randomUUID()}`;
  const worker = new Worker(
    new URL('./embedding-model-switch-memory-probe.worker.ts', import.meta.url),
    {
      name: sourceId,
      type: 'module',
    }
  );
  let sourceRemoved = false;
  try {
    const { beforeTeardown, disposedModels, evictions } = await runWorkerProbe(worker, sourceId);
    const beforeSnapshot = getEmbeddingTelemetrySnapshot();

    worker.terminate();
    removeEmbeddingTelemetrySource(sourceId);
    sourceRemoved = true;
    const afterSummary = summarizeSource(getEmbeddingTelemetrySnapshot(), sourceId);

    return {
      afterTeardown: {
        estimatedGpuBytes: afterSummary.estimatedGpuBytes,
        estimatedHeapBytes: afterSummary.estimatedHeapBytes,
        residentCount: afterSummary.residentCount,
      },
      beforeTeardown,
      disposedModels,
      firstGpuEvictedModel: requireFirstEvictedModel(evictions, 'webgpu'),
      firstWasmEvictedModel: requireFirstEvictedModel(evictions, 'wasm'),
      health: beforeSnapshot.health,
      residentLimitEvictionCount: evictions.length,
    };
  } finally {
    worker.terminate();
    if (!sourceRemoved) {
      removeEmbeddingTelemetrySource(sourceId);
    }
  }
}
