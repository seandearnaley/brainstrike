import {
  createEmptyEmbeddingTelemetrySnapshot,
  type EmbeddingTelemetrySnapshot,
} from '@brainstrike/embedding-worker';

export {
  assertEmbeddingTelemetrySnapshot,
  createEmptyEmbeddingTelemetrySnapshot,
  type EmbeddingTelemetrySnapshot,
} from '@brainstrike/embedding-worker';

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
