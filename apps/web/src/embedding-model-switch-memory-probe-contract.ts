import {
  assertEmbedWorkerPipelineCacheDiagnostic,
  type EmbedWorkerPipelineCacheDiagnostic,
} from '@brainstrike/embedding-worker/pipeline-cache-controller';

export const BST369_WASM_MODEL_BYTES = 8 * 1024 * 1024;
export const BST369_GPU_MODEL_BYTES = 16 * 1024 * 1024;

export interface EmbeddingModelSwitchMemoryProbeSummary {
  readonly estimatedGpuBytes: number;
  readonly estimatedHeapBytes: number;
  readonly memoryEstimateUnavailableCount: number;
  readonly residentCount: number;
}

export interface WebE2EEmbeddingModelSwitchMemoryProbeResult {
  readonly afterTeardown: Omit<
    EmbeddingModelSwitchMemoryProbeSummary,
    'memoryEstimateUnavailableCount'
  >;
  readonly beforeTeardown: EmbeddingModelSwitchMemoryProbeSummary;
  readonly disposedModels: readonly string[];
  readonly firstGpuEvictedModel: string;
  readonly firstWasmEvictedModel: string;
  readonly health: {
    readonly failureCount: number;
    readonly lastFailure: string | null;
  };
  readonly residentLimitEvictionCount: number;
}

export interface EmbeddingModelSwitchMemoryProbeRequest {
  readonly sourceId: string;
  readonly type: 'run';
}

export type EmbeddingModelSwitchMemoryProbeWorkerMessage =
  | {
      readonly diagnostic: EmbedWorkerPipelineCacheDiagnostic;
      readonly type: 'diagnostic';
    }
  | {
      readonly disposedModels: readonly string[];
      readonly type: 'complete';
    }
  | {
      readonly message: string;
      readonly type: 'error';
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertEmbeddingModelSwitchMemoryProbeRequest(
  value: unknown
): asserts value is EmbeddingModelSwitchMemoryProbeRequest {
  if (!isRecord(value) || value['type'] !== 'run') {
    throw new Error('Embedding model-switch probe requires a run request.');
  }
  if (!(typeof value['sourceId'] === 'string' && value['sourceId'].length > 0)) {
    throw new Error('Embedding model-switch probe requires a source identity.');
  }
}

export function assertEmbeddingModelSwitchMemoryProbeWorkerMessage(
  value: unknown
): asserts value is EmbeddingModelSwitchMemoryProbeWorkerMessage {
  if (!isRecord(value)) {
    throw new Error('Embedding model-switch probe worker message must be an object.');
  }
  switch (value['type']) {
    case 'diagnostic':
      assertEmbedWorkerPipelineCacheDiagnostic(value['diagnostic']);
      return;
    case 'complete': {
      const disposedModels = value['disposedModels'];
      if (
        !(
          Array.isArray(disposedModels) &&
          disposedModels.every((model) => typeof model === 'string' && model.length > 0)
        )
      ) {
        throw new Error('Embedding model-switch probe completion requires disposed model IDs.');
      }
      return;
    }
    case 'error':
      if (!(typeof value['message'] === 'string' && value['message'].length > 0)) {
        throw new Error('Embedding model-switch probe error requires a message.');
      }
      return;
    default:
      throw new Error('Embedding model-switch probe worker message has an invalid type.');
  }
}
