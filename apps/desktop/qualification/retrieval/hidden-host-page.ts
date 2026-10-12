/**
 * BST-1939 Phase 3: the page half of produce-hidden-host-vectors.ts. It is
 * bundled with the production StreamingEmbeddingWorkerClient and imported
 * into the hidden embedding-host page, where it drives the production worker
 * asset. Raw token states (the pooling check and the unit-test fixture) come
 * from the product's own Transformers.js build, imported from the same assets.
 */
import { StreamingEmbeddingWorkerClient } from '@brainstrike/embedding-worker';

interface VendorTensor {
  readonly data: ArrayLike<number>;
  readonly dims: readonly number[];
  tolist(): unknown[];
  readonly type: string;
}
interface VendorTokenizer {
  encode(text: string): number[];
  // biome-ignore lint/style/useNamingConvention: Transformers.js API name.
  readonly model_max_length: number;
}
interface VendorExtractor {
  dispose(): Promise<void>;
  // biome-ignore lint/style/useNamingConvention: Transformers.js API name.
  model(inputs: unknown): Promise<{ last_hidden_state: VendorTensor }>;
  tokenizer(
    texts: string[],
    options: { padding: boolean; truncation: boolean }
  ): {
    // biome-ignore lint/style/useNamingConvention: Transformers.js API name.
    attention_mask: VendorTensor;
    // biome-ignore lint/style/useNamingConvention: Transformers.js API name.
    input_ids: VendorTensor;
  };
  (texts: string[], options: { normalize: boolean; pooling: string }): Promise<VendorTensor>;
}
interface VendorTransformers {
  // biome-ignore lint/style/useNamingConvention: Transformers.js API name.
  AutoTokenizer: {
    // biome-ignore lint/style/useNamingConvention: Transformers.js API name.
    from_pretrained(model: string, options: { revision: string }): Promise<VendorTokenizer>;
  };
  pipeline(
    task: 'feature-extraction',
    model: string,
    options: { device: 'webgpu'; dtype: string; revision: string }
  ): Promise<VendorExtractor>;
}

export interface ModelChoice {
  readonly dtype: string;
  readonly modelId: string;
  readonly pooling: 'mean' | 'cls';
  readonly revision: string;
}

export interface EmbedResult {
  readonly elapsedMs: number;
  readonly metadata: {
    readonly device: string;
    readonly dimensions: number;
    readonly dtype: string;
    readonly fallbackApplied: boolean;
    readonly revision?: string;
  };
  readonly tokens: readonly number[];
  readonly vectors: readonly (readonly number[])[];
}

export interface QualificationPage {
  embed(model: ModelChoice, texts: readonly string[]): Promise<EmbedResult>;
  loadTokenizer(modelId: string, revision: string): Promise<{ readonly modelMaxLength: number }>;
  poolingCheck(
    model: ModelChoice,
    texts: readonly string[],
    vectors: readonly (readonly number[])[]
  ): Promise<{ readonly maxDifference: number }>;
  recordStates(
    model: Omit<ModelChoice, 'pooling'>,
    texts: readonly string[]
  ): Promise<{
    readonly attentionMask: number[][];
    readonly dims: number[];
    readonly inputIds: number[][];
    readonly lastHiddenState: number[];
  }>;
  terminate(): void;
}

const integers = (tensor: VendorTensor): number[][] =>
  tensor.tolist().map((row) => (row as (bigint | number)[]).map(Number));

/** Installs `window.qualification` over the production worker and Transformers.js assets. */
export async function install(transformersUrl: string, workerUrl: string): Promise<void> {
  const transformers = (await import(/* @vite-ignore */ transformersUrl)) as VendorTransformers;
  const client = new StreamingEmbeddingWorkerClient({ workerUrl });
  let tokenizer: VendorTokenizer | undefined;
  const page: QualificationPage = {
    async embed(model, texts) {
      const tokens = texts.map((text) => tokenizer?.encode(text).length ?? 0);
      const vectors: number[][] = [];
      const begun = performance.now();
      const metadata = await client.stream(
        {
          deviceHint: 'webgpu',
          dtype: model.dtype as 'fp16',
          id: crypto.randomUUID(),
          maxBatchSize: 64,
          model: model.modelId,
          pooling: model.pooling,
          revision: model.revision,
          texts,
          type: 'embed',
        },
        {
          onBatch(batch: { readonly vectors: readonly Float32Array[] }) {
            for (const vector of batch.vectors) {
              vectors.push(Array.from(vector));
            }
          },
          signal: AbortSignal.timeout(600_000),
        }
      );
      return { elapsedMs: performance.now() - begun, metadata, tokens, vectors };
    },
    async loadTokenizer(modelId, revision) {
      tokenizer = await transformers.AutoTokenizer.from_pretrained(modelId, { revision });
      return { modelMaxLength: tokenizer.model_max_length };
    },
    async poolingCheck(model, texts, vectors) {
      const extractor = await transformers.pipeline('feature-extraction', model.modelId, {
        device: 'webgpu',
        dtype: model.dtype,
        revision: model.revision,
      });
      const expected = (
        await extractor([...texts], { normalize: true, pooling: model.pooling })
      ).tolist() as number[][];
      await extractor.dispose();
      let maxDifference = 0;
      for (const [row, vector] of vectors.entries()) {
        for (const [column, value] of vector.entries()) {
          maxDifference = Math.max(
            maxDifference,
            Math.abs(value - (expected[row]?.[column] ?? Number.NaN))
          );
        }
      }
      return { maxDifference };
    },
    async recordStates(model, texts) {
      const extractor = await transformers.pipeline('feature-extraction', model.modelId, {
        device: 'webgpu',
        dtype: model.dtype,
        revision: model.revision,
      });
      const inputs = extractor.tokenizer([...texts], { padding: true, truncation: true });
      const states = (await extractor.model(inputs)).last_hidden_state;
      if (states.type !== 'float32') {
        throw new Error(`Recorded token states must be float32, not ${states.type}`);
      }
      const recorded = {
        attentionMask: integers(inputs.attention_mask),
        dims: [...states.dims],
        inputIds: integers(inputs.input_ids),
        lastHiddenState: Array.from(states.data),
      };
      await extractor.dispose();
      return recorded;
    },
    terminate() {
      client.terminate();
    },
  };
  (window as unknown as { qualification: QualificationPage }).qualification = page;
}
