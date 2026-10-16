/// <reference lib="webworker" />
/**
 * The production embedding worker over a synthetic Transformers runtime, so a
 * test runs the whole embedding stack offline. Each text's vector is a pure
 * function of its text, at the dimensions the worker's URL names
 * (`#dimensions=`, three by default), each batch taking `#delay=`
 * milliseconds, and every pipeline load is reported on the BroadcastChannel
 * it names (`#channel=`).
 */
import {
  EMBEDDING_WORKER_TEST_RUNTIME_AUTOMATION,
  EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_KEY,
  EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_MARKER,
} from '@brainstrike/embedding-worker/test-runtime-bootstrap';
import { syntheticVector } from './synthetic-embedding';

const fragment = new URLSearchParams(self.location.hash.slice(1));
const channel = new BroadcastChannel(fragment.get('channel') ?? 'synthetic-embedding');
/** The model's own dimensions; the worker truncates to the plan's. */
const dimensions = Number(fragment.get('dimensions') ?? 3);
/** How long each batch takes (`#delay=`, milliseconds), so a test can overlap one. */
const delay = Number(fragment.get('delay') ?? 0);

function createSyntheticRuntime(): Record<string, unknown> {
  return {
    env: { allowRemoteModels: false },
    pipeline: async (
      task: unknown,
      model: unknown,
      options: { readonly device?: unknown; readonly dtype?: unknown; readonly revision?: unknown }
    ) => {
      if (task !== 'feature-extraction' || typeof model !== 'string') {
        throw new Error('The synthetic runtime serves feature extraction only.');
      }
      if (model.includes('broken')) {
        throw new Error(`The synthetic runtime has no model ${model}.`);
      }
      channel.postMessage({
        device: options.device,
        dtype: options.dtype,
        kind: 'load',
        model,
        revision: options.revision ?? null,
      });
      const extractor = async (texts: readonly string[]) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return texts.map((text) => syntheticVector(text, dimensions));
      };
      return Object.assign(extractor, {
        dispose: async () => undefined,
        tokenizer: (text: string) => ({
          input_ids: { dims: [1, text.split(/\s+/u).filter(Boolean).length + 2] },
        }),
      });
    },
    tensorConstructor: class SyntheticTensor {},
  };
}

Object.defineProperty(globalThis, EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_KEY, {
  configurable: true,
  value: Object.freeze({
    automation: EMBEDDING_WORKER_TEST_RUNTIME_AUTOMATION,
    marker: EMBEDDING_WORKER_TEST_RUNTIME_BOOTSTRAP_MARKER,
    takeRuntime: () => Object.freeze({ runtime: createSyntheticRuntime(), webGpuClassProxy: true }),
  }),
});

await import('@brainstrike/embedding-worker/worker');
