import { describe, expect, it } from 'vitest';
import { stringSetsEqual } from '../tree/optimized-file-tree';

describe('stringSetsEqual', () => {
  it('treats two sets with identical members as equal regardless of identity', () => {
    const a = new Set(['/a', '/b', '/c']);
    const b = new Set(['/c', '/b', '/a']);
    expect(a).not.toBe(b);
    expect(stringSetsEqual(a, b)).toBe(true);
  });

  it('is false when sizes differ', () => {
    expect(stringSetsEqual(new Set(['/a']), new Set(['/a', '/b']))).toBe(false);
  });

  it('is false when a member differs', () => {
    expect(stringSetsEqual(new Set(['/a', '/b']), new Set(['/a', '/x']))).toBe(false);
  });

  it('is true for the same reference (fast path)', () => {
    const a = new Set(['/a']);
    expect(stringSetsEqual(a, a)).toBe(true);
  });

  it('is true for two empty sets', () => {
    expect(stringSetsEqual(new Set(), new Set())).toBe(true);
  });
});
