import { describe, expect, test } from 'vitest';
import type { VisibleSplice } from '../lazy-tree-protocol';
import { applySplicesImmutable, applySplicesInPlace } from '../visible-splices';

describe('applySplicesImmutable', () => {
  test('returns unchanged array when no splices', () => {
    const source = [1, 2, 3];
    const result = applySplicesImmutable(source, []);
    expect(result).toEqual([1, 2, 3]);
    expect(result).not.toBe(source); // new array
  });

  test('applies single insertion splice', () => {
    const source = [1, 2, 3];
    const splices: (VisibleSplice & { items: number[] })[] = [
      { index: 1, deleteCount: 0, items: [10, 20] },
    ];
    const result = applySplicesImmutable(source, splices);
    expect(result).toEqual([1, 10, 20, 2, 3]);
  });

  test('applies single deletion splice', () => {
    const source = [1, 2, 3, 4, 5];
    const splices: (VisibleSplice & { items: number[] })[] = [
      { index: 1, deleteCount: 2, items: [] },
    ];
    const result = applySplicesImmutable(source, splices);
    expect(result).toEqual([1, 4, 5]);
  });

  test('applies single replacement splice', () => {
    const source = [1, 2, 3, 4, 5];
    const splices: (VisibleSplice & { items: number[] })[] = [
      { index: 1, deleteCount: 2, items: [20, 30] },
    ];
    const result = applySplicesImmutable(source, splices);
    expect(result).toEqual([1, 20, 30, 4, 5]);
  });

  test('applies multiple splices in order', () => {
    const source = [1, 2, 3, 4, 5];
    const splices: (VisibleSplice & { items: number[] })[] = [
      { index: 1, deleteCount: 1, items: [20] }, // replace 2 with 20
      { index: 3, deleteCount: 0, items: [40] }, // insert 40 before 4
    ];
    const result = applySplicesImmutable(source, splices);
    expect(result).toEqual([1, 20, 3, 40, 4, 5]);
  });

  test('handles out of order splices by sorting', () => {
    const source = [1, 2, 3, 4, 5];
    const splices: (VisibleSplice & { items: number[] })[] = [
      { index: 3, deleteCount: 0, items: [40] },
      { index: 1, deleteCount: 1, items: [20] },
    ];
    const result = applySplicesImmutable(source, splices);
    expect(result).toEqual([1, 20, 3, 40, 4, 5]);
  });
});

describe('applySplicesInPlace', () => {
  test('modifies array in place', () => {
    const arr = [1, 2, 3, 4, 5];
    const splices: (VisibleSplice & { items: number[] })[] = [
      { index: 1, deleteCount: 2, items: [20, 30] },
    ];
    applySplicesInPlace(arr, splices);
    expect(arr).toEqual([1, 20, 30, 4, 5]);
  });

  test('handles multiple splices correctly', () => {
    const arr = [1, 2, 3, 4, 5];
    const splices: (VisibleSplice & { items: number[] })[] = [
      { index: 1, deleteCount: 1, items: [20] },
      { index: 3, deleteCount: 0, items: [40] },
    ];
    applySplicesInPlace(arr, splices);
    expect(arr).toEqual([1, 20, 3, 40, 4, 5]);
  });
});
