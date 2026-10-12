import { describe, expect, it } from 'vitest';
import { hasCompactionSummarySchema } from '../compaction-summary-schema';

describe('compaction summary section schema', () => {
  it.each([
    {
      name: 'inline',
      text: 'Goal: Ship X\nState: Ready\nDecisions: Keep it small\nNext: Test\nFiles touched: src/a.ts',
    },
    {
      name: 'newline',
      text: 'Goal:\nShip X\nState:\nReady\nDecisions:\nKeep it small\nNext:\nTest\nFiles touched:\nsrc/a.ts',
    },
    {
      name: 'mixed',
      text: 'Goal: Ship X\nState:\nReady\nDecisions: Keep it small\nNext:\nTest\nFiles touched: src/a.ts',
    },
  ])('accepts $name section content', ({ text }) => {
    expect(hasCompactionSummarySchema(text)).toBe(true);
  });

  it('ignores an incidental duplicate header-shaped line in section prose', () => {
    expect(
      hasCompactionSummarySchema(
        'Goal: Ship X\nState: Ready\nDecisions:\nNext: was also discussed here.\nNext: Test\nFiles touched: src/a.ts'
      )
    ).toBe(true);
  });

  it.each([
    'Goal: Ship X\nState: Ready\nDecisions: Keep it small\nNext: Test',
    'Goal: Ship X\nNext: Test\nState: Ready\nDecisions: Keep it small\nFiles touched: src/a.ts',
  ])('rejects a missing or out-of-order section', (text) => {
    expect(hasCompactionSummarySchema(text)).toBe(false);
  });
});
