import { expect, test } from 'vitest';
import {
  assertWalCutCoverage,
  assertWalCutOffsets,
  matchesRecoveredWalCommit,
  partitionWalCuts,
} from './helpers/wal-cut-cases.js';

test('the 32 WAL cases cover all 8241 offsets exactly once, including both endpoints', () => {
  const first = 100;
  const last = first + 8240;
  const ranges = partitionWalCuts(first, last, 32);
  expect(ranges).toHaveLength(32);
  expect(() => assertWalCutCoverage(ranges, first, last)).not.toThrow();
  const offsets = ranges.flatMap(({ first: from, last: to }) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i)
  );
  expect(offsets).toEqual(Array.from({ length: 8241 }, (_, i) => first + i));
  expect(new Set(offsets).size).toBe(8241);
  expect(() => assertWalCutOffsets(offsets, first, last)).not.toThrow();
  expect(Math.max(...ranges.map((range) => range.last - range.first + 1))).toBe(258);
});

test.each([
  ['empty', []],
  ['missing first', [1, 2, 3, 4]],
  ['missing last', [0, 1, 2, 3]],
  ['interior gap', [0, 1, 3, 4]],
  ['duplicated cut', [0, 1, 2, 2, 3, 4]],
  ['gap and duplicate with same count', [0, 1, 2, 4, 4]],
] as const)('completed coverage rejects %s', (_name, cuts) => {
  expect(() => assertWalCutOffsets(cuts, 0, 4)).toThrow();
});

test.each([
  ['empty', []],
  ['missing first endpoint', [{ first: 1, last: 9 }]],
  ['missing last endpoint', [{ first: 0, last: 8 }]],
  [
    'interior gap',
    [
      { first: 0, last: 3 },
      { first: 5, last: 9 },
    ],
  ],
  [
    'duplicated boundary',
    [
      { first: 0, last: 4 },
      { first: 4, last: 9 },
    ],
  ],
  [
    'duplicated case',
    [
      { first: 0, last: 4 },
      { first: 0, last: 4 },
      { first: 5, last: 9 },
    ],
  ],
  [
    'empty range',
    [
      { first: 0, last: 4 },
      { first: 5, last: 4 },
      { first: 5, last: 9 },
    ],
  ],
  ['past the endpoint', [{ first: 0, last: 10 }]],
] as const)('coverage rejects %s', (_name, ranges) => {
  expect(() => assertWalCutCoverage(ranges, 0, 9)).toThrow();
});

test.each([
  [0, 9, 1],
  [0, 9, 3],
  [0, 9, 10],
  [19, 8240, 32],
] as const)('coverage is exhaustive for %i..%i in %i nonempty cases', (first, last, count) => {
  const ranges = partitionWalCuts(first, last, count);
  expect(ranges).toHaveLength(count);
  expect(() => assertWalCutCoverage(ranges, first, last)).not.toThrow();
});

test.each([
  [5, 4, 1],
  [0, 2, 0],
  [0, 2, 4],
  [0, 2, 1.5],
  [0.5, 2, 1],
] as const)('partition refuses invalid geometry %i..%i / %i', (first, last, count) => {
  expect(() => partitionWalCuts(first, last, count)).toThrow();
});

test.each([
  [0, 49, 'ok', true],
  [9, 49, 'ok', true],
  [10, 50, 'ok', true],
  [0, 50, 'ok', false],
  [9, 50, 'ok', false],
  [10, 49, 'ok', false],
  [9, 48, 'ok', false],
  [9, 49, 'corrupt', false],
  [10, 50, undefined, false],
] as const)(
  'recovery control: cut %i rows %i check %s matches=%s',
  (cut, rows, check, expected) => {
    expect(matchesRecoveredWalCommit(cut, 10, rows, check)).toBe(expected);
  }
);
