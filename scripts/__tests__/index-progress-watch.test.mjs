import assert from 'node:assert/strict';
import { test } from 'node:test';

// The foreground-latency benchmark's stall rule
// (apps/desktop/e2e/foreground-latency-under-index-build.desktop.test.ts). A real
// build that never finishes cannot be produced on demand, so the decision is
// tested here; Node strips the module's types.
import { createIndexProgressWatch } from '../../apps/desktop/e2e/utils/index-progress-watch.ts';

const ZERO = { chunkCount: 0, chunkedFileCount: 0, embeddedChunkCount: 0, fileCount: 0 };

function counts(overrides) {
  return { ...ZERO, ...overrides };
}

test('a build that never moves stalls exactly when the window has passed', () => {
  const watch = createIndexProgressWatch({ initial: ZERO, stallWindowMs: 1000, startedAtMs: 0 });

  assert.equal(watch.observe(ZERO, 999), 'progressing');
  assert.equal(watch.observe(ZERO, 1000), 'stalled');
});

test('any changed count restarts the window', () => {
  const watch = createIndexProgressWatch({ initial: ZERO, stallWindowMs: 1000, startedAtMs: 0 });

  for (const [field, at] of [
    ['fileCount', 900],
    ['chunkedFileCount', 1800],
    ['chunkCount', 2700],
    ['embeddedChunkCount', 3600],
  ]) {
    assert.equal(watch.observe(counts({ [field]: 1 + at }), at), 'progressing');
  }
  const last = counts({ embeddedChunkCount: 3601 });
  assert.equal(watch.observe(last, 4599), 'progressing');
  assert.equal(watch.observe(last, 4600), 'stalled');
});

test('a build that stops after making progress stalls one window after its last change', () => {
  const watch = createIndexProgressWatch({ initial: ZERO, stallWindowMs: 1000, startedAtMs: 0 });
  const partial = counts({
    chunkCount: 40,
    chunkedFileCount: 5,
    embeddedChunkCount: 12,
    fileCount: 5,
  });

  assert.equal(watch.observe(partial, 500), 'progressing');
  assert.equal(watch.observe(partial, 1499), 'progressing');
  assert.equal(watch.observe(partial, 1500), 'stalled');
});

test('the stall window must be positive', () => {
  assert.throws(
    () => createIndexProgressWatch({ initial: ZERO, stallWindowMs: 0, startedAtMs: 0 }),
    /positive number of ms/
  );
});
