import { describe, expect, it } from 'vitest';
import {
  docSummaryExecute,
  docSummaryInputSchema,
  searchDocsExecute,
  searchDocsInputSchema,
  type WebDocEntry,
} from '../tools/docs-search';

const makeDoc = (overrides: Partial<WebDocEntry>): WebDocEntry => ({
  id: 'doc',
  title: 'Doc',
  summary: 'Summary.',
  url: '/docs/doc',
  tags: [],
  sections: [],
  ...overrides,
});

describe('docs-search schemas', () => {
  it('trims queries, applies default limits, and rejects invalid queries', () => {
    expect(searchDocsInputSchema.parse({ query: '  ipc tools  ' })).toEqual({
      query: 'ipc tools',
      limit: 5,
    });
    expect(searchDocsInputSchema.safeParse({ query: '  a  ' }).success).toBe(false);
    expect(searchDocsInputSchema.safeParse({ query: 'valid\0query' }).success).toBe(false);
    expect(searchDocsInputSchema.safeParse({ query: 'valid', limit: 11 }).success).toBe(false);
  });

  it('validates summary doc ids', () => {
    expect(docSummaryInputSchema.parse({ docId: 'assistant-ui-integration' })).toEqual({
      docId: 'assistant-ui-integration',
    });
    expect(docSummaryInputSchema.safeParse({ docId: '' }).success).toBe(false);
  });
});

describe('searchDocsExecute', () => {
  it('searches the default index and returns highlights with bounded results', async () => {
    const response = await searchDocsExecute({ query: 'ipc tools', limit: 3 });

    expect(response.query).toBe('ipc tools');
    expect(response.limit).toBe(3);
    expect(response.results.length).toBeLessThanOrEqual(3);
    expect(response.totalResults).toBeGreaterThan(0);
    expect(response.results[0]).toMatchObject({
      id: 'web-tool-dispatcher',
      title: expect.stringContaining('Tool Execution IPC Bridge Plan'),
      score: expect.any(Number),
    });
    expect(response.results[0]?.highlight.toLowerCase()).toContain('ipc');
  });

  it('ranks title matches above body matches and sorts ties by title', async () => {
    const customIndex: WebDocEntry[] = [
      makeDoc({
        id: 'z-body-only',
        title: 'Zebra',
        summary: 'Shared runtime note.',
        url: '/z',
      }),
      makeDoc({
        id: 'b-title',
        title: 'Beta Shared',
        summary: 'Runtime note.',
        url: '/b',
      }),
      makeDoc({
        id: 'a-title',
        title: 'Alpha Shared',
        summary: 'Runtime note.',
        url: '/a',
      }),
    ];

    const response = await searchDocsExecute({ query: 'shared', limit: 10 }, customIndex);

    expect(response.results.map((result) => result.id)).toEqual([
      'a-title',
      'b-title',
      'z-body-only',
    ]);
    expect(response.results.map((result) => result.score)).toEqual([14, 14, 4]);
  });

  it('returns no results for empty or token-limited queries without matching indexed tokens', async () => {
    const customIndex = [
      makeDoc({
        id: 'ninth-token-only',
        title: 'Ninth',
        summary: 'Only ninth appears here.',
      }),
      makeDoc({
        id: 'eighth-token',
        title: 'Eight',
        summary: 'Only eight appears here.',
      }),
    ];

    await expect(searchDocsExecute({ query: '   ', limit: 5 }, customIndex)).resolves.toMatchObject(
      {
        query: '',
        totalResults: 0,
        results: [],
      }
    );

    const response = await searchDocsExecute(
      { query: 'one two three four five six seven eight ninth', limit: 5 },
      customIndex
    );

    expect(response.results.map((result) => result.id)).toEqual(['eighth-token']);
  });
});

describe('docSummaryExecute', () => {
  it('returns numbered sections and version metadata when present', async () => {
    const customIndex = [
      makeDoc({
        id: 'versioned',
        title: 'Versioned Doc',
        summary: 'Versioned summary.',
        url: '/versioned',
        tags: ['versioned'],
        sections: ['First section.', 'Second section.'],
        versionIntroduced: '2026.06',
      }),
    ];

    const response = await docSummaryExecute({ docId: ' versioned ' }, customIndex);

    expect(response.doc).toEqual({
      id: 'versioned',
      title: 'Versioned Doc',
      summary: 'Versioned summary.',
      url: '/versioned',
      tags: ['versioned'],
      versionIntroduced: '2026.06',
      sections: [
        { id: 'versioned-section-1', text: 'First section.' },
        { id: 'versioned-section-2', text: 'Second section.' },
      ],
    });
  });

  it('omits version metadata when absent and throws for missing docs', async () => {
    const customIndex = [
      makeDoc({
        id: 'plain',
        title: 'Plain Doc',
        summary: 'Plain summary.',
        url: '/plain',
        sections: ['Only section.'],
      }),
    ];

    const response = await docSummaryExecute({ docId: 'plain' }, customIndex);

    expect(response.doc).not.toHaveProperty('versionIntroduced');
    expect(response.doc.sections).toEqual([{ id: 'plain-section-1', text: 'Only section.' }]);
    await expect(docSummaryExecute({ docId: 'missing' }, customIndex)).rejects.toThrow(
      'Doc not found: missing'
    );
  });
});
