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
  decode(
    ids: number[],
    // biome-ignore lint/style/useNamingConvention: Transformers.js option names.
    options: { clean_up_tokenization_spaces: boolean; skip_special_tokens: boolean }
  ): string;
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
  /**
   * Cuts each text to the loaded tokenizer's first `cap` tokens, special
   * tokens included, by decoding that token prefix; `exact` says whether the
   * cut text re-encodes to exactly that prefix.
   */
  truncate(
    texts: readonly string[],
    cap: number
  ): Promise<
    {
      /** The re-encoded cut differs from the token prefix at most in its last token. */
      readonly boundaryOnly: boolean;
      readonly capped: boolean;
      readonly exact: boolean;
      readonly text: string;
      /** The uncut text's token count, special tokens included. */
      readonly tokens: number;
    }[]
  >;
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
    async truncate(texts, cap) {
      if (!tokenizer) {
        throw new Error('Load the tokenizer before truncating.');
      }
      const loaded = tokenizer;
      const specials = loaded.encode('').length;
      return texts.map((text) => {
        const content = loaded.encode(text).slice(1, -1);
        const tokens = content.length + specials;
        if (tokens <= cap) {
          return { boundaryOnly: true, capped: false, exact: true, text, tokens };
        }
        // Byte-level decoding without space clean-up, so the cut text re-encodes to its prefix.
        const decode = (ids: number[]) =>
          // biome-ignore lint/style/useNamingConvention: Transformers.js option names.
          loaded.decode(ids, { clean_up_tokenization_spaces: false, skip_special_tokens: true });
        let kept = cap - specials;
        let cut = decode(content.slice(0, kept));
        while (loaded.encode(cut).length > cap && kept > 0) {
          kept -= 1;
          cut = decode(content.slice(0, kept));
        }
        const again = loaded.encode(cut).slice(1, -1);
        const leading = again.findIndex((id, index) => id !== content[index]);
        const matching = leading < 0 ? again.length : leading;
        return {
          boundaryOnly: matching >= kept - 1,
          capped: true,
          exact: again.length === kept && matching === kept,
          text: cut,
          tokens,
        };
      });
    },
  };
  (window as unknown as { qualification: QualificationPage }).qualification = page;
}
