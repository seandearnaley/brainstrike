/**
 * Vector-parity regression test for @huggingface/transformers (BST-1065).
 *
 * NOTE: This downloads a real ML model (~23MB, Xenova/all-MiniLM-L6-v2) over the
 * network and runs real inference. It is gated PURELY BY FILENAME — the
 * `.models.test.*` suffix. The base vitest.config.mts excludes that suffix, so
 * this file NEVER runs in the pure `test` lane, the `test:integration` lane, or
 * `test:coverage` (and therefore never in CI). It runs ONLY via the manual
 * `test:models` script, which selects it through vitest.models.config.mts.
 *
 * What this guards: the fixture in
 * `fixtures/embedding-vector-parity-baseline.json` was captured from
 * @huggingface/transformers@4.2.0 (the version this repo ran at the time this
 * test was added). This test re-embeds the SAME fixed corpus with whatever
 * version of the library is currently installed and asserts the resulting
 * vectors stay within tolerance of the fixture via cosine similarity. It is a
 * standing regression guard against a future major-version bump silently
 * degrading embedding quality — the exact gap this ticket found when the
 * 3.8.1 -> 4.0.1 bump (commit ec567fc75) landed with no parity check at all.
 *
 * This test calls the RAW `pipeline()` API directly (not TransformersBackend /
 * SimpleEmbeddingService), because this test runs under plain Node (vitest
 * `environment: 'node'`), not a browser/Worker context. transformers.js's Node
 * build routes through onnxruntime-node, whose CPU execution provider is named
 * "cpu" (the browser build's "wasm" EP name — what
 * packages/embedding-worker/src/embedding.worker.ts actually requests in the
 * real renderer — doesn't apply outside a browser/Worker context; both are
 * pure-CPU fp32 ONNX Runtime execution). Going through TransformersBackend
 * here would not work at all under plain Node: TransformersBackend
 * .isDeviceAvailable() requires a `window`/`navigator.gpu` global that a Node
 * vitest environment never provides, by design (it throws rather than
 * silently falling back — see docs/agents/local-inference.md). This test is
 * therefore a library-version parity guard on the CPU/fp32 numeric path, not a
 * WebGPU or renderer-path smoke test — the hidden-host renderer's own
 * WebGPU-path behavior is verified separately (manual CDT smoke, scheduled by
 * the orchestrator).
 *
 * Tolerance: 0.999 cosine similarity per vector. A pure runtime/library-version
 * comparison on IDENTICAL model weights should be extremely close to 1.0; the
 * measured value when this fixture was captured (v3.8.1 vs v4.2.0, same model,
 * same corpus, CPU/fp32) was 1.000000 on every item (see PR description for
 * the full comparison). 0.999 leaves headroom for legitimate numerical
 * differences from a future runtime change while still catching a real
 * regression.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pipeline } from '@huggingface/transformers';
import { describe, expect, it } from 'vitest';

const LONG_TIMEOUT = 120_000; // 2 minutes — matches sibling .models.test.ts files.

interface ParityFixture {
  readonly corpus: readonly string[];
  readonly device: string;
  readonly dimensions: number;
  readonly dtype: string;
  readonly libraryVersion: string;
  readonly model: string;
  readonly vectors: readonly (readonly number[])[];
}

const fixturePath = fileURLToPath(
  new URL('./fixtures/embedding-vector-parity-baseline.json', import.meta.url)
);
const fixture: ParityFixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

const SIMILARITY_TOLERANCE = 0.999;

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined || bi === undefined) {
      throw new Error(`Unexpected undefined vector component at index ${i}`);
    }
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

describe('embedding vector parity (BST-1065)', () => {
  it(
    'stays within tolerance of the committed baseline for the currently installed transformers.js',
    async () => {
      const extractor = await pipeline('feature-extraction', fixture.model, {
        device: fixture.device as 'cpu',
        dtype: fixture.dtype as 'fp32',
      });

      const output = await extractor([...fixture.corpus], {
        normalize: true,
        pooling: 'mean',
      });

      const dims = output.dims as number[];
      const perVectorLength = dims.at(-1) as number;
      expect(perVectorLength).toBe(fixture.dimensions);

      const flat = Array.from(output.data as ArrayLike<number>);
      const similarities: number[] = [];
      for (let i = 0; i < fixture.corpus.length; i++) {
        const current = flat.slice(i * perVectorLength, (i + 1) * perVectorLength);
        const baseline = fixture.vectors[i];
        if (baseline === undefined) {
          throw new Error(`Fixture is missing a baseline vector for corpus index ${i}`);
        }
        similarities.push(cosineSimilarity(current, baseline));
      }

      const minSimilarity = Math.min(...similarities);
      expect(
        minSimilarity,
        `Lowest cosine similarity against baseline (captured from @huggingface/transformers@${fixture.libraryVersion}) was ${minSimilarity}, below the ${SIMILARITY_TOLERANCE} tolerance. Per-item: ${JSON.stringify(similarities)}`
      ).toBeGreaterThanOrEqual(SIMILARITY_TOLERANCE);
    },
    LONG_TIMEOUT
  );
});
