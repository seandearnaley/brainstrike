/// <reference lib="webworker" />

import {
  BST369_GPU_MODEL_BYTES,
  BST369_PROBE_AUTOMATION_FRAGMENT_KEY,
  BST369_PROBE_AUTOMATION_TOKEN,
  BST369_PROBE_CHANNEL_FRAGMENT_KEY,
  BST369_TEST_RUNTIME_BOOTSTRAP_KEY,
  BST369_TEST_RUNTIME_BOOTSTRAP_MARKER,
  BST369_WARM_GPU_MODELS,
  BST369_WARM_WASM_MODELS,
  BST369_WASM_MODEL_BYTES,
  BST369_WINDOW_A_GPU_MODELS,
  BST369_WINDOW_A_WASM_MODELS,
  BST369_WINDOW_B_GPU_MODELS,
  BST369_WINDOW_B_WASM_MODELS,
  type EmbeddingModelSwitchMemoryProbeWorkerMessage,
} from './embedding-model-switch-memory-probe-contract';

type ProbeDevice = 'wasm' | 'webgpu';

interface SyntheticModelContract {
  readonly bytes: number;
  readonly device: ProbeDevice;
  readonly dtype: 'fp16' | 'q4';
}

interface RetainedResource {
  store: Uint8Array | null;
}

const PAGE_SIZE_BYTES = 4096;
const workerScope = self as DedicatedWorkerGlobalScope;

function parseSingleFragmentValue(params: URLSearchParams, key: string): string {
  const values = params.getAll(key);
  const value = values[0];
  if (values.length !== 1 || !value) {
    throw new Error(`BST-369 worker requires exactly one ${key} fragment value.`);
  }
  return value;
}

const fragment = workerScope.location.hash.startsWith('#')
  ? workerScope.location.hash.slice(1)
  : workerScope.location.hash;
const fragmentParams = new URLSearchParams(fragment);
const channelName = parseSingleFragmentValue(fragmentParams, BST369_PROBE_CHANNEL_FRAGMENT_KEY);
const automationToken = parseSingleFragmentValue(
  fragmentParams,
  BST369_PROBE_AUTOMATION_FRAGMENT_KEY
);
if (automationToken !== BST369_PROBE_AUTOMATION_TOKEN) {
  throw new Error('BST-369 worker requires the explicit webdriver init attestation.');
}

const probeChannel = new BroadcastChannel(channelName);
const retainedResources = new Map<string, RetainedResource>();
const disposedModels: string[] = [];
let allocationCount = 0;

function modelContracts(): ReadonlyMap<string, SyntheticModelContract> {
  const contracts = new Map<string, SyntheticModelContract>();
  for (const model of [
    ...BST369_WARM_WASM_MODELS,
    ...BST369_WINDOW_A_WASM_MODELS,
    ...BST369_WINDOW_B_WASM_MODELS,
  ]) {
    contracts.set(model, { bytes: BST369_WASM_MODEL_BYTES, device: 'wasm', dtype: 'q4' });
  }
  for (const model of [
    ...BST369_WARM_GPU_MODELS,
    ...BST369_WINDOW_A_GPU_MODELS,
    ...BST369_WINDOW_B_GPU_MODELS,
  ]) {
    contracts.set(model, { bytes: BST369_GPU_MODEL_BYTES, device: 'webgpu', dtype: 'fp16' });
  }
  return contracts;
}

const fixedModelContracts = modelContracts();

function postMessage(message: EmbeddingModelSwitchMemoryProbeWorkerMessage): void {
  probeChannel.postMessage(message);
}

function failProbeWorker(message: string): never {
  postMessage({ message, type: 'error' });
  throw new Error(message);
}

function postState(): void {
  let liveBytes = 0;
  for (const resource of retainedResources.values()) {
    if (resource.store === null) {
      failProbeWorker('BST-369 physical ledger retained a released resource.');
    }
    liveBytes += resource.store.byteLength;
  }
  postMessage({
    allocationCount,
    disposedModels: [...disposedModels],
    liveBytes,
    residentModels: [...retainedResources.keys()],
    type: 'state',
  });
}

function allocatePageTouchedStore(bytes: number): Uint8Array {
  const store = new Uint8Array(bytes);
  for (let offset = 0; offset < store.byteLength; offset += PAGE_SIZE_BYTES) {
    store[offset] = (offset / PAGE_SIZE_BYTES) % 251;
  }
  store[store.byteLength - 1] = 1;
  return store;
}

function createSyntheticPipeline(
  model: string,
  contract: SyntheticModelContract
): ((texts: readonly string[]) => Promise<readonly Float32Array[]>) & {
  dispose: () => Promise<void>;
} {
  if (retainedResources.has(model)) {
    throw new Error(`BST-369 synthetic runtime attempted to allocate duplicate model ${model}.`);
  }
  const resource: RetainedResource = {
    store: allocatePageTouchedStore(contract.bytes),
  };
  retainedResources.set(model, resource);
  allocationCount += 1;
  postState();

  const pipeline = async (texts: readonly string[]): Promise<readonly Float32Array[]> => {
    if (!(Array.isArray(texts) && texts.length === 1 && texts[0] === 'bst-369-memory-probe')) {
      throw new Error('BST-369 synthetic runtime received an unexpected embedding payload.');
    }
    if (resource.store === null) {
      throw new Error(`BST-369 synthetic runtime used disposed model ${model}.`);
    }
    return [Float32Array.of(1, 2, 3, 4)];
  };
  pipeline.dispose = async (): Promise<void> => {
    if (resource.store === null || !retainedResources.has(model)) {
      failProbeWorker(`BST-369 synthetic runtime disposed model ${model} more than once.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (resource.store === null || !retainedResources.delete(model)) {
      failProbeWorker(`BST-369 synthetic runtime disposed model ${model} more than once.`);
    }
    resource.store = null;
    disposedModels.push(model);
    postState();
  };
  return pipeline;
}

function createSyntheticRuntime(): Record<string, unknown> {
  const gpuDevice = {
    createCommandEncoder: () => ({
      finish: () => ({ __brand: 'GPUCommandBuffer' as const }),
    }),
    lost: new Promise<never>(() => undefined),
    queue: {
      submit: (_buffers: readonly unknown[]): void => undefined,
    },
  };

  return {
    env: {
      allowRemoteModels: false,
      backends: { onnx: { webgpu: { device: gpuDevice } } },
    },
    pipeline: async (
      task: unknown,
      model: unknown,
      options: { readonly device?: unknown; readonly dtype?: unknown }
    ) => {
      if (task !== 'feature-extraction' || typeof model !== 'string') {
        throw new Error('BST-369 synthetic runtime received an unsupported pipeline request.');
      }
      const contract = fixedModelContracts.get(model);
      if (!contract) {
        throw new Error(`BST-369 synthetic runtime rejected unknown model ${model}.`);
      }
      if (options.device !== contract.device || options.dtype !== contract.dtype) {
        throw new Error(`BST-369 synthetic runtime rejected routing drift for ${model}.`);
      }
      return createSyntheticPipeline(model, contract);
    },
    tensorConstructor: class SyntheticTensor {},
  };
}

function installRuntimeBootstrap(): void {
  if (Reflect.has(globalThis, BST369_TEST_RUNTIME_BOOTSTRAP_KEY)) {
    throw new Error('BST-369 runtime bootstrap was installed more than once.');
  }
  let consumed = false;
  Object.defineProperty(globalThis, BST369_TEST_RUNTIME_BOOTSTRAP_KEY, {
    configurable: true,
    enumerable: false,
    value: Object.freeze({
      automation: BST369_PROBE_AUTOMATION_TOKEN,
      marker: BST369_TEST_RUNTIME_BOOTSTRAP_MARKER,
      takeRuntime: () => {
        if (consumed) {
          throw new Error('BST-369 runtime bootstrap was consumed more than once.');
        }
        consumed = true;
        return Object.freeze({
          runtime: createSyntheticRuntime(),
          webGpuClassProxy: true,
        });
      },
    }),
    writable: false,
  });
}

async function bootstrapProductionWorker(): Promise<void> {
  installRuntimeBootstrap();
  await import('@brainstrike/embedding-worker/worker');
  postMessage({ type: 'ready' });
}

try {
  await bootstrapProductionWorker();
} catch (error) {
  postMessage({
    message: error instanceof Error ? error.message : String(error),
    type: 'error',
  });
  throw error;
}
