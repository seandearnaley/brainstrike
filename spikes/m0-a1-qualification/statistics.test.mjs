import assert from 'node:assert/strict';
import test from 'node:test';
import { contentionPercentile, displayPercentile, evaluate } from './statistics.mjs';

test('display keeps recovered ceil-index aggregation; contention keeps its floor-index rule', () => {
  const samples = Array.from({ length: 20 }, (_, index) => index + 1);
  assert.equal(displayPercentile(samples, 95), 19);
  assert.equal(contentionPercentile(samples, 95), 20);
  for (const percentile of [displayPercentile, contentionPercentile]) {
    assert.equal(percentile(samples, 0), 1);
    assert.equal(percentile(samples, 100), 20);
    assert.equal(percentile([7], 95), 7);
  }
});

test('display uses pooled chunks and inclusive P plus 5ms; contention uses the three-run median', () => {
  const pass = evaluate(
    /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
      S: [...new Array(95).fill(15), ...new Array(5).fill(90)],
      P: new Array(100).fill(10),
    },
    [9, 1, 2]
  );
  assert.equal(pass.display.sqliteP95, 15);
  assert.equal(pass.display.pass, true);
  assert.equal(pass.contention.median, 2);
  assert.equal(pass.contention.pass, true);
  const fail = evaluate(
    /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
      S: new Array(100).fill(15.001),
      P: new Array(100).fill(10),
    },
    [1, 2.001, 3]
  );
  assert.equal(fail.display.pass, false);
  assert.equal(fail.contention.pass, false);
});

test('missing and invalid data cannot qualify through NaN or Infinity comparisons', () => {
  for (const samples of [[], [Number.NaN], [Number.POSITIVE_INFINITY], [-1]]) {
    assert.throws(() => displayPercentile(samples, 95));
    assert.throws(() => contentionPercentile(samples, 95));
  }
  assert.throws(() =>
    evaluate(
      /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
        S: [1],
        P: [1],
      },
      [1, 2]
    )
  );
  assert.throws(() =>
    evaluate(
      /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
        S: [1],
        P: [1],
      },
      [1, 2, Number.POSITIVE_INFINITY]
    )
  );
});
