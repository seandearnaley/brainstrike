import { describe, expect, it } from 'vitest';
import { hasCompactionSummarySchema } from '../compaction-summary-schema';

const SECTIONS = [
  'Goal: Ship X',
  'Constraints: Keep the public API; no new dependencies',
  'Decisions: Keep it small',
  'Errors and fixes: The build failed on a missing import; added it',
  'State: Ready',
  'Next: Test',
];

describe('compaction summary section schema', () => {
  it.each([
    { name: 'inline', text: SECTIONS.join('\n') },
    {
      name: 'newline',
      text: SECTIONS.map((section) => section.replace(': ', ':\n')).join('\n'),
    },
    {
      name: 'markdown headers',
      text: SECTIONS.map((section) => `## ${section.replace(': ', '\n')}`).join('\n'),
    },
  ])('accepts $name section content', ({ text }) => {
    expect(hasCompactionSummarySchema(text)).toBe(true);
  });

  it('ignores an incidental duplicate header-shaped line in section prose', () => {
    expect(
      hasCompactionSummarySchema(
        [
          ...SECTIONS.slice(0, 4),
          'State:\nNext: was also discussed here.',
          ...SECTIONS.slice(5),
        ].join('\n')
      )
    ).toBe(true);
  });

  it.each(
    SECTIONS.map((section, index) => ({
      header: section.split(':')[0],
      text: SECTIONS.filter((_, at) => at !== index).join('\n'),
    }))
  )('refuses a summary without $header', ({ text }) => {
    expect(hasCompactionSummarySchema(text)).toBe(false);
  });

  it('refuses sections out of order', () => {
    expect(
      hasCompactionSummarySchema(
        [SECTIONS[0], SECTIONS[4], ...SECTIONS.slice(1, 4), SECTIONS[5]].join('\n')
      )
    ).toBe(false);
  });

  it('refuses the old five sections', () => {
    expect(
      hasCompactionSummarySchema(
        'Goal: Ship X\nState: Ready\nDecisions: Keep it small\nNext: Test\nFiles touched: src/a.ts'
      )
    ).toBe(false);
  });
});
