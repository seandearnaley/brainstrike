/// <reference lib="webworker" />

import { createEmbeddingPipelineCacheController } from '@brainstrike/embedding-worker/pipeline-cache-controller';
import {
  assertEmbeddingModelSwitchMemoryProbeRequest,
  BST369_GPU_MODEL_BYTES,
  BST369_WASM_MODEL_BYTES,
  type EmbeddingModelSwitchMemoryProbeWorkerMessage,
} from './embedding-model-switch-memory-probe-contract';

const workerScope = self as DedicatedWorkerGlobalScope;
let runStarted = false;

function postMessage(message: EmbeddingModelSwitchMemoryProbeWorkerMessage): void {
  workerScope.postMessage(message);
}

function loadModelsInOrder(
  models: readonly string[],
  loadModel: (model: string) => Promise<void>
): Promise<void> {
  return models.reduce(
    (previous, model) => previous.then(() => loadModel(model)),
    Promise.resolve()
  );
}

async function runProbe(sourceId: string): Promise<void> {
  const disposedModels: string[] = [];
  let clock = 0;
  const controller = createEmbeddingPipelineCacheController({
    load: async (model: string) => ({
      dispose: () => {
        disposedModels.push(model);
      },
    }),
    now: () => {
      clock += 1;
      return clock;
    },
    publishDiagnostic: (diagnostic) => {
      postMessage({ diagnostic, type: 'diagnostic' });
    },
    workerInstanceId: sourceId,
  });

  const loadWasm = async (model: string): Promise<void> => {
    await controller.load({
      device: 'wasm',
      dtype: 'q4',
      estimatedModelBytes: BST369_WASM_MODEL_BYTES,
      model,
    });
  };
  const loadGpu = async (model: string): Promise<void> => {
    await controller.load({
      device: 'webgpu',
      dtype: 'fp16',
      estimatedModelBytes: BST369_GPU_MODEL_BYTES,
      model,
    });
  };

  try {
    await loadWasm('wasm-a');
    await loadWasm('wasm-b');
    await loadWasm('wasm-c');
    await loadWasm('wasm-a');
    await loadWasm('wasm-d');
    await loadModelsInOrder(
      Array.from({ length: 8 }, (_, index) => `wasm-cycle-${index}`),
      loadWasm
    );

    await loadGpu('gpu-a');
    await loadGpu('gpu-b');
    await loadModelsInOrder(
      Array.from({ length: 8 }, (_, index) => `gpu-cycle-${index}`),
      loadGpu
    );

    await controller.waitForPendingDisposals();
    postMessage({ type: 'resident-state' });
  } finally {
    await controller.close();
  }

  postMessage({ disposedModels, type: 'complete' });
}

workerScope.onmessage = (event: MessageEvent<unknown>): void => {
  try {
    assertEmbeddingModelSwitchMemoryProbeRequest(event.data);
    if (runStarted) {
      throw new Error('Embedding model-switch probe accepts exactly one run request.');
    }
    runStarted = true;
    void runProbe(event.data.sourceId).catch((error: unknown) => {
      postMessage({
        message: error instanceof Error ? error.message : String(error),
        type: 'error',
      });
    });
  } catch (error) {
    postMessage({
      message: error instanceof Error ? error.message : String(error),
      type: 'error',
    });
  }
};
