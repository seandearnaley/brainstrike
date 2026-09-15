import { SemanticRecall } from '@mastra/core/processors';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * PROVEN UPSTREAM DEFECT (pnpm patch, @mastra/core 1.64.0; present on 1.66.0
 * and main): `SemanticRecall` initializes `hasher = xxhash()` per INSTANCE, and
 * `MastraMemory.getInputProcessors`/`getOutputProcessors` construct a new
 * `SemanticRecall` on EVERY model step when semantic recall is enabled. Each
 * `xxhash()` is a fresh `WebAssembly.instantiate`, and every instance reserves
 * V8's guard region, so a fan-out of four specialists spends V8's WebAssembly
 * reservation budget within minutes: every later instantiation in the process
 * fails with "Cannot allocate Wasm memory for new instance" — the retrieval
 * tool, message persistence and the memory observer all died with it (live-app
 * verifier runs 6–9 and thread-debug pack 2026-09-15T02-25-01Z). The patch
 * shares one hasher across all instances.
 */
const options = {
  embedder: {} as never,
  indexName: 'test',
  storage: {} as never,
  vector: {} as never,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SemanticRecall hasher (patched @mastra/core)', () => {
  it('instantiates its WebAssembly hasher at most once across many instances', async () => {
    const instantiate = vi.spyOn(WebAssembly, 'instantiate');
    const recalls = Array.from({ length: 25 }, () => new SemanticRecall(options));
    // The hasher is a promise created at construction; settle them all.
    await Promise.all(
      recalls.map((recall) => (recall as unknown as { hasher: Promise<unknown> }).hasher)
    );
    expect(instantiate.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
