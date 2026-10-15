// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { setsEqual } from '../utils/sets-equal';

describe('setsEqual', () => {
  it('treats two sets with identical members as equal regardless of identity', () => {
    const a = new Set(['/a', '/b', '/c']);
    const b = new Set(['/c', '/b', '/a']);
    expect(a).not.toBe(b);
    expect(setsEqual(a, b)).toBe(true);
  });

  it('is false when sizes differ', () => {
    expect(setsEqual(new Set(['/a']), new Set(['/a', '/b']))).toBe(false);
  });

  it('is false when a member differs', () => {
    expect(setsEqual(new Set(['/a', '/b']), new Set(['/a', '/x']))).toBe(false);
  });

  it('is true for the same reference (fast path)', () => {
    const a = new Set(['/a']);
    expect(setsEqual(a, a)).toBe(true);
  });

  it('is true for two empty sets', () => {
    expect(setsEqual(new Set(), new Set())).toBe(true);
  });
});
