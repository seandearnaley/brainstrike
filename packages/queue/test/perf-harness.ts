import { createBrowserEmbeddingQueue } from '../src';

/**
 * Manual perf harness for local profiling. Run with:
 *
 *    pnpm --filter @brainstrike/queue tsx packages/queue/test/perf-harness.ts
 *
 * The harness intentionally avoids exporting metrics so that it never runs during Vitest.
 */
async function run(): Promise<void> {
  const queue = createBrowserEmbeddingQueue();
  const batchSize = 64;
  const texts = Array.from({ length: batchSize }, (_, index) => `sample sentence ${index}`);
  const taskId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `perf-${Date.now()}`;

  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const result = await queue.add({
    kind: 'embed',
    id: taskId,
    model: 'Xenova/all-MiniLM-L6-v2',
    texts,
    truncateDim: 384,
    deviceHint: 'auto'
  });
  const finished = typeof performance !== 'undefined' ? performance.now() : Date.now();

  // eslint-disable-next-line no-console -- intentional developer-facing output.
  console.log({
    vectors: result.vectors.length,
    device: result.metadata.device,
    elapsedMs: Number((finished - started).toFixed(2))
  });

  await queue.drain();
}

if (typeof import.meta !== 'undefined' && (import.meta as { main?: boolean }).main === true) {
  run().catch((error) => {
    // eslint-disable-next-line no-console -- intentional developer-facing output.
    console.error(error);
    process.exitCode = 1;
  });
}
