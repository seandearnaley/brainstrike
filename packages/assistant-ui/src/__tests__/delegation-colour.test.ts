import { describe, expect, it } from 'vitest';
import {
  DELEGATION_COLOUR_COUNT,
  delegationColourIndex,
  delegationRailIndices,
} from '../delegation-colour';

describe('delegationColourIndex', () => {
  it('is stable for one id and always lands inside the curated set', () => {
    const first = delegationColourIndex('call_9f2a');
    expect(delegationColourIndex('call_9f2a')).toBe(first);
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThanOrEqual(DELEGATION_COLOUR_COUNT);
  });

  it('pins the hash so a persisted thread keeps the same rails after an upgrade', () => {
    // Filled by vitest on the first green run (`toMatchInlineSnapshot` writes
    // the values back). Mutation: change the FNV prime, the offset, or the
    // modulus and this row fails.
    expect(
      ['background-child-1', 'background-child-2', 'background-child-3', 'background-child-4'].map(
        delegationColourIndex
      )
    ).toMatchInlineSnapshot(`
      [
        1,
        2,
        7,
        8,
      ]
    `);
  });

  it('spreads sequential ids across every colour (no bucket starves)', () => {
    const counts = new Map<number, number>();
    for (let index = 0; index < 4000; index += 1) {
      const colour = delegationColourIndex(`call_${index}`);
      counts.set(colour, (counts.get(colour) ?? 0) + 1);
    }
    expect(counts.size).toBe(DELEGATION_COLOUR_COUNT);
    for (const count of counts.values()) {
      // Uniform would be 500; a bucket under 300 means the hash is skewed.
      expect(count).toBeGreaterThan(300);
    }
  });

  it('refuses an empty id instead of inventing a colour', () => {
    expect(() => delegationColourIndex('')).toThrow(/non-empty/);
  });
});

describe('delegationRailIndices', () => {
  it('yields one rail per path edge, keyed by the edge parent call id', () => {
    const path = [
      { parentToolCallId: 'delegate-root' },
      { parentToolCallId: 'delegate-grandchild' },
    ];
    expect(delegationRailIndices(path)).toEqual([
      delegationColourIndex('delegate-root'),
      delegationColourIndex('delegate-grandchild'),
    ]);
    expect(delegationRailIndices([])).toEqual([]);
  });
});
