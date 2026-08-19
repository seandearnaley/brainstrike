export const BST369_WASM_MODEL_BYTES = 8 * 1024 * 1024;
export const BST369_GPU_MODEL_BYTES = 16 * 1024 * 1024;
export const BST369_MAX_LIVE_BYTES = 3 * BST369_WASM_MODEL_BYTES + BST369_GPU_MODEL_BYTES;
export const BST369_PROBE_CHANNEL_FRAGMENT_KEY = 'brainstrike-bst369-probe-channel';
export const BST369_PROBE_AUTOMATION_FRAGMENT_KEY = 'brainstrike-bst369-automation';
export const BST369_PROBE_AUTOMATION_TOKEN = EMBEDDING_WORKER_TEST_RUNTIME_AUTOMATION;
export const BST369_TEST_RUNTIME_BOOTSTRAP_KEY = EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_KEY;
export const BST369_TEST_RUNTIME_BOOTSTRAP_MARKER = EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_MARKER;
export const BST369_E2E_INIT_FLAG = '__brainstrikeEnableEmbeddingModelSwitchMemoryProbe__';

export const BST369_WARM_WASM_MODELS = ['wasm-a', 'wasm-b', 'wasm-c', 'wasm-a', 'wasm-d'] as const;
export const BST369_WARM_GPU_MODELS = ['gpu-a', 'gpu-b'] as const;
export const BST369_WINDOW_A_WASM_MODELS = [
  'wasm-cycle-0',
  'wasm-cycle-1',
  'wasm-cycle-2',
  'wasm-cycle-3',
] as const;
export const BST369_WINDOW_A_GPU_MODELS = [
  'gpu-cycle-0',
  'gpu-cycle-1',
  'gpu-cycle-2',
  'gpu-cycle-3',
] as const;
export const BST369_WINDOW_B_WASM_MODELS = [
  'wasm-cycle-4',
  'wasm-cycle-5',
  'wasm-cycle-6',
  'wasm-cycle-7',
] as const;
export const BST369_WINDOW_B_GPU_MODELS = [
  'gpu-cycle-4',
  'gpu-cycle-5',
  'gpu-cycle-6',
  'gpu-cycle-7',
] as const;

export type EmbeddingModelSwitchMemoryBarrier = 'warm' | 'window-a' | 'window-b';

export interface EmbeddingModelSwitchMemoryProbeSummary {
  readonly estimatedGpuBytes: number;
  readonly estimatedHeapBytes: number;
  readonly memoryEstimateUnavailableCount: number;
  readonly residentCount: number;
}

export interface EmbeddingModelSwitchPhysicalState {
  readonly allocationCount: number;
  readonly disposedModels: readonly string[];
  readonly liveBytes: number;
  readonly residentModels: readonly string[];
}

export interface EmbeddingModelSwitchAgentMemorySample {
  readonly label: 'after-teardown' | 'baseline' | EmbeddingModelSwitchMemoryBarrier;
  readonly totalBytes: number;
  readonly workerBreakdownCount: number;
  readonly workerBytes: number;
  readonly workerUrls: readonly string[];
}

export interface WebE2EEmbeddingModelSwitchMemoryProbeResult {
  readonly afterTeardown: Omit<
    EmbeddingModelSwitchMemoryProbeSummary,
    'memoryEstimateUnavailableCount'
  >;
  readonly beforeTeardown: EmbeddingModelSwitchMemoryProbeSummary;
  readonly failureReasons: readonly string[];
  readonly firstGpuEvictedModel: string;
  readonly firstWasmEvictedModel: string;
  readonly memory: {
    readonly afterTeardown: EmbeddingModelSwitchAgentMemorySample;
    readonly baseline: EmbeddingModelSwitchAgentMemorySample;
    readonly warm: EmbeddingModelSwitchAgentMemorySample;
    readonly windowA: EmbeddingModelSwitchAgentMemorySample;
    readonly windowB: EmbeddingModelSwitchAgentMemorySample;
  };
  readonly physical: {
    readonly warm: EmbeddingModelSwitchPhysicalState;
    readonly windowA: EmbeddingModelSwitchPhysicalState;
    readonly windowB: EmbeddingModelSwitchPhysicalState;
  };
  readonly residentLimitEvictionCount: number;
  readonly telemetrySourceRemoved: boolean;
  readonly transferBytes: number;
  readonly transferEventCount: number;
}

export type EmbeddingModelSwitchMemoryProbeWorkerMessage =
  | {
      readonly type: 'ready';
    }
  | ({
      readonly type: 'state';
    } & EmbeddingModelSwitchPhysicalState)
  | {
      readonly message: string;
      readonly type: 'error';
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0)
  );
}

export function assertEmbeddingModelSwitchMemoryProbeWorkerMessage(
  value: unknown
): asserts value is EmbeddingModelSwitchMemoryProbeWorkerMessage {
  if (!isRecord(value)) {
    throw new Error('Embedding model-switch probe worker message must be an object.');
  }
  if (value['type'] === 'ready') {
    return;
  }
  if (value['type'] === 'error') {
    if (!(typeof value['message'] === 'string' && value['message'].length > 0)) {
      throw new Error('Embedding model-switch probe error requires a message.');
    }
    return;
  }
  if (value['type'] !== 'state') {
    throw new Error('Embedding model-switch probe worker message has an invalid type.');
  }
  if (
    !(
      Number.isSafeInteger(value['allocationCount']) &&
      Number(value['allocationCount']) >= 0 &&
      Number.isSafeInteger(value['liveBytes']) &&
      Number(value['liveBytes']) >= 0 &&
      isStringArray(value['residentModels']) &&
      Array.isArray(value['disposedModels']) &&
      value['disposedModels'].every((entry) => typeof entry === 'string' && entry.length > 0)
    )
  ) {
    throw new Error('Embedding model-switch probe worker state is malformed.');
  }
}

import {
  EMBEDDING_WORKER_TEST_RUNTIME_AUTOMATION,
  EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_KEY,
  EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_MARKER,
} from '@brainstrike/embedding-worker/test-runtime-bootstrap';
