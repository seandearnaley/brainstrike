import { expect, test } from 'vitest';
import { ProcessCounterRing } from '../../diagnostics/process-counter-ring';
import { createProcessCounterSampler } from '../../diagnostics/process-counter-sampler';

const snapshot = {
  counts: { compile: 1, failures: 0, instance: 2, instantiate: 3, memory: 4 },
  installedAt: '2026-10-13T00:00:00.000Z',
  recentFailures: [],
};
const memory = { heapUsed: 2048, rss: 4096 } as NodeJS.MemoryUsage;
test('records real process counters without pretending the retired database queue is empty', async () => {
  const ring = new ProcessCounterRing(3);
  const sampler = createProcessCounterSampler({ counter: { snapshot: () => snapshot }, ring });
  await sampler.sample(memory);
  expect(ring.list()).toEqual([
    expect.objectContaining({
      backgroundTasks: null,
      backgroundTasksUnavailableReason: expect.any(String),
      heapUsedKb: 2,
      rssKb: 4,
      wasm: snapshot.counts,
    }),
  ]);
});
test('keeps consecutive observations in the bounded existing ring', async () => {
  const ring = new ProcessCounterRing(2);
  const sampler = createProcessCounterSampler({ counter: { snapshot: () => snapshot }, ring });
  await sampler.sample(memory);
  await sampler.sample({ ...memory, rss: 8192 });
  await sampler.sample({ ...memory, rss: 16_384 });
  expect(ring.list().map((entry) => entry.rssKb)).toEqual([8, 16]);
});
test('stop retains earlier observations and prevents later ticks', async () => {
  const ring = new ProcessCounterRing(3);
  const sampler = createProcessCounterSampler({ counter: { snapshot: () => snapshot }, ring });
  await sampler.sample(memory);
  sampler.stop();
  await sampler.sample(memory);
  expect(ring.list()).toHaveLength(1);
});
