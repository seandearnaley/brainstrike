import assert from 'node:assert/strict';
import test from 'node:test';
import { readRendererWindows } from '../../e2e/utils/foreground-latency-probes.ts';

const key = '__brainstrikeForegroundLatencyRenderer__';
const page = { evaluate: async (operation, argument) => operation(argument) };

test('phase evidence preserves the outlier interval and renderer clock for timeline correlation', async () => {
  globalThis[key] = {
    frames: [90, 100, 116.7, 333.4, 350.1, 366.8],
    longTasks: [{ duration: 70, startTime: 120 }],
    marks: { end: 351, start: 100 },
  };
  try {
    const result = await readRendererWindows(page, [['start', 'end']]);
    assert.deepEqual(result.windows, [{ endMs: 351, from: 'start', startMs: 100, to: 'end' }]);
    assert.deepEqual(result.frameIntervalsMs, [
      { endMs: 116.7, startMs: 100 },
      { endMs: 333.4, startMs: 116.7 },
      { endMs: 350.1, startMs: 333.4 },
      { endMs: 366.8, startMs: 350.1 },
    ]);
    assert.equal(result.frameIntervalsMs.length, result.frameGapsMs.length);
    assert.deepEqual(
      result.frameGapsMs,
      result.frameIntervalsMs.map(({ startMs, endMs }) => endMs - startMs)
    );
    assert.ok(Math.max(...result.frameGapsMs) > 216);
    assert.deepEqual(result.longTasks, [{ durationMs: 70, startMs: 120 }]);
    assert.deepEqual(result.longTaskDurationsMs, [70]);
    assert.equal(result.timeOriginMs, performance.timeOrigin);
  } finally {
    delete globalThis[key];
  }
});

test('disjoint phases retain absolute timestamps and the existing start-inside selection', async () => {
  globalThis[key] = {
    frames: [0, 16, 40, 80, 96, 112],
    longTasks: [{ duration: 55, startTime: 45 }],
    marks: { a: 0, b: 20, c: 80, d: 100 },
  };
  try {
    const result = await readRendererWindows(page, [
      ['a', 'b'],
      ['c', 'd'],
    ]);
    assert.deepEqual(result.frameIntervalsMs, [
      { endMs: 16, startMs: 0 },
      { endMs: 40, startMs: 16 },
      { endMs: 96, startMs: 80 },
      { endMs: 112, startMs: 96 },
    ]);
    assert.deepEqual(result.frameGapsMs, [16, 24, 16, 16]);
    assert.deepEqual(result.longTasks, []);
  } finally {
    delete globalThis[key];
  }
});
