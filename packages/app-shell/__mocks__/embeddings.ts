import type { EmbeddingTelemetrySnapshot } from '@brainstrike/embeddings';

export function assertEmbeddingTelemetrySnapshot(value: unknown): EmbeddingTelemetrySnapshot {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error('Embedding telemetry snapshot must be an object.');
  }
  return value as EmbeddingTelemetrySnapshot;
}

export function createEmptyEmbeddingTelemetrySnapshot(): EmbeddingTelemetrySnapshot {
  return {
    batchTransfer: { batchCount: 0, lastBytes: 0, peakBytes: 0, totalBytes: 0 },
    cache: {
      entries: [],
      estimatedGpuBytes: 0,
      estimatedHeapBytes: 0,
      memoryEstimateUnavailableCount: 0,
      residentCount: 0,
    },
    health: { failureCount: 0, lastFailure: null },
    lastUpdatedAt: null,
    peakVectorsInFlight: 0,
  };
}

const embeddingTelemetrySnapshot = createEmptyEmbeddingTelemetrySnapshot();

export function getEmbeddingTelemetrySnapshot(): EmbeddingTelemetrySnapshot {
  return embeddingTelemetrySnapshot;
}

export function subscribeEmbeddingTelemetry(_listener: () => void): () => void {
  return () => {};
}

export function subscribeEmbeddingTelemetryThrottled(_listener: () => void): () => void {
  return () => {};
}

export class SimpleEmbeddingService {
  static listModels(): string[] {
    return ['stub-model'];
  }
  static getDefaultModelKey(): string {
    return 'stub-model';
  }
  async embed(_text: string): Promise<Float32Array> {
    // Return a deterministic stubbed embedding
    return new Float32Array([0]);
  }
  dispose(): void {
    // no-op for tests
  }
}
