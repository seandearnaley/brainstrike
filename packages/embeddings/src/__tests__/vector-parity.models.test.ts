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
 * The model revision is PINNED (not the mutable `main` ref) so this test
 * isolates the one variable it exists to check: a future upstream re-export
 * or retag of the model on the Hub must not be able to move the numbers out
 * from under a transformers.js version comparison (PR #2188 review feedback).
 *
 * Tolerance: 0.999 cosine similarity per vector. A pure runtime/library-version
 * comparison on IDENTICAL model weights should be extremely close to 1.0; the
 * measured value when this fixture was captured (v3.8.1 vs v4.2.0, same model,
 * same pinned revision, same corpus, CPU/fp32) was ~1.0 (min 0.9999999999999998)
 * on every item (see PR description for the full comparison). 0.999 leaves
 * headroom for legitimate numerical differences from a future runtime change
 * while still catching a real regression.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pipeline } from '@huggingface/transformers';
import { describe, expect, it } from 'vitest';

const LONG_TIMEOUT = 120_000; // 2 minutes — matches sibling .models.test.ts files.

const SUPPORTED_DEVICES = ['cpu', 'wasm'] as const;
type SupportedDevice = (typeof SUPPORTED_DEVICES)[number];

const SUPPORTED_DTYPES = ['fp32', 'fp16'] as const;
type SupportedDtype = (typeof SUPPORTED_DTYPES)[number];

interface ParityFixture {
  readonly corpus: readonly string[];
  readonly device: SupportedDevice;
  readonly dimensions: number;
  readonly dtype: SupportedDtype;
  readonly libraryVersion: string;
  readonly model: string;
  readonly revision: string;
  readonly vectors: readonly (readonly number[])[];
}

/**
 * Narrow an `unknown` JSON.parse result into ParityFixture, validating the
 * literal-union fields (`device`/`dtype`) rather than asserting them via
 * `as`. A bad `dtype`/`device` would otherwise throw an opaque error deep
 * inside `pipeline()` instead of a clear "fixture metadata is invalid"
 * failure (PR #2188 review feedback).
 */
function parseParityFixture(raw: unknown): ParityFixture {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Parity fixture is not an object.');
  }
  const value = raw as Record<string, unknown>;

  const { corpus, device, dimensions, dtype, libraryVersion, model, revision, vectors } = value;

  if (!(Array.isArray(corpus) && corpus.every((entry) => typeof entry === 'string'))) {
    throw new Error('Parity fixture "corpus" must be a string array.');
  }
  if (typeof device !== 'string' || !SUPPORTED_DEVICES.includes(device as SupportedDevice)) {
    throw new Error(
      `Parity fixture "device" must be one of ${SUPPORTED_DEVICES.join(', ')}, got ${JSON.stringify(device)}.`
    );
  }
  if (typeof dimensions !== 'number') {
    throw new Error('Parity fixture "dimensions" must be a number.');
  }
  if (typeof dtype !== 'string' || !SUPPORTED_DTYPES.includes(dtype as SupportedDtype)) {
    throw new Error(
      `Parity fixture "dtype" must be one of ${SUPPORTED_DTYPES.join(', ')}, got ${JSON.stringify(dtype)}.`
    );
  }
  if (typeof libraryVersion !== 'string') {
    throw new Error('Parity fixture "libraryVersion" must be a string.');
  }
  if (typeof model !== 'string') {
    throw new Error('Parity fixture "model" must be a string.');
  }
  if (typeof revision !== 'string' || revision.length === 0) {
    throw new Error('Parity fixture "revision" must be a non-empty string.');
  }
  if (
    !(
      Array.isArray(vectors) &&
      vectors.every((v) => Array.isArray(v) && v.every((n) => typeof n === 'number'))
    )
  ) {
    throw new Error('Parity fixture "vectors" must be an array of number arrays.');
  }

  return {
    corpus,
    device: device as SupportedDevice,
    dimensions,
    dtype: dtype as SupportedDtype,
    libraryVersion,
    model,
    revision,
    vectors: vectors as readonly (readonly number[])[],
  };
}

const fixturePath = fileURLToPath(
  new URL('./fixtures/embedding-vector-parity-baseline.json', import.meta.url)
);
const fixtureRaw: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));
const fixture = parseParityFixture(fixtureRaw);

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
      // Guard against a fixture that lost its corpus/vectors: an empty corpus
      // would otherwise let Math.min(...[]) === Infinity pass vacuously below
      // (PR #2188 review feedback).
      expect(fixture.corpus.length).toBeGreaterThan(0);
      expect(fixture.vectors).toHaveLength(fixture.corpus.length);

      const extractor = await pipeline('feature-extraction', fixture.model, {
        device: fixture.device,
        dtype: fixture.dtype,
        revision: fixture.revision,
      });

      const output = await extractor([...fixture.corpus], {
        normalize: true,
        pooling: 'mean',
      });

      const dims = output.dims as number[];
      const perVectorLength = dims.at(-1) as number;
      expect(perVectorLength).toBe(fixture.dimensions);

      const flat = Array.from(output.data as ArrayLike<number>);
      // Bounds-check the flattened output shape explicitly: if pooling ever
      // stopped collapsing the sequence dimension (e.g. token-level output
      // instead of the pooled [batch, hidden] shape), `dims.at(-1)` alone
      // would still read `dimensions` while `flat` is far longer than
      // `corpus.length * perVectorLength` — that's a pooling-contract break,
      // not a numerics regression, and should fail with its own message
      // rather than surfacing as a misleading similarity-tolerance failure
      // (PR #2188 review feedback).
      expect(flat).toHaveLength(fixture.corpus.length * perVectorLength);

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
