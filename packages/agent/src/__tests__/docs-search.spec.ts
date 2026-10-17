import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';
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
  sections: [],
  summary: 'Summary.',
  tags: [],
  title: 'Doc',
  url: '/docs/doc',
  ...overrides,
});

describe('docs-search schemas', () => {
  it('trims queries, applies default limits, and rejects invalid queries', () => {
    expect(
      wireDecoder(searchDocsInputSchema, { errors: 'all' })({ query: '  ipc tools  ' })
    ).toEqual({
      limit: 5,
      query: 'ipc tools',
    });
    expect(
      Schema.decodeUnknownResult(searchDocsInputSchema, { errors: 'all' })({ query: '  a  ' })
        ._tag === 'Success'
    ).toBe(false);
    expect(
      Schema.decodeUnknownResult(searchDocsInputSchema, { errors: 'all' })({
        query: 'valid\0query',
      })._tag === 'Success'
    ).toBe(false);
    expect(
      Schema.decodeUnknownResult(searchDocsInputSchema, { errors: 'all' })({
        limit: 11,
        query: 'valid',
      })._tag === 'Success'
    ).toBe(false);
  });

  it('validates summary doc ids', () => {
    expect(
      wireDecoder(docSummaryInputSchema, { errors: 'all' })({ docId: 'assistant-ui-integration' })
    ).toEqual({
      docId: 'assistant-ui-integration',
    });
    expect(
      Schema.decodeUnknownResult(docSummaryInputSchema, { errors: 'all' })({ docId: '' })._tag ===
        'Success'
    ).toBe(false);
  });
});

describe('searchDocsExecute', () => {
  it('searches the default index and returns highlights with bounded results', async () => {
    const response = await searchDocsExecute({ limit: 3, query: 'ipc tools' });

    expect(response.query).toBe('ipc tools');
    expect(response.limit).toBe(3);
    expect(response.results.length).toBeLessThanOrEqual(3);
    expect(response.totalResults).toBeGreaterThan(0);
    expect(response.results[0]).toMatchObject({
      id: 'web-tool-dispatcher',
      score: expect.any(Number),
      title: expect.stringContaining('Tool Execution IPC Bridge Plan'),
    });
    expect(response.results[0]?.highlight.toLowerCase()).toContain('ipc');
  });

  it('ranks title matches above body matches and sorts ties by title', async () => {
    const customIndex: WebDocEntry[] = [
      makeDoc({
        id: 'z-body-only',
        summary: 'Shared runtime note.',
        title: 'Zebra',
        url: '/z',
      }),
      makeDoc({
        id: 'b-title',
        summary: 'Runtime note.',
        title: 'Beta Shared',
        url: '/b',
      }),
      makeDoc({
        id: 'a-title',
        summary: 'Runtime note.',
        title: 'Alpha Shared',
        url: '/a',
      }),
    ];

    const response = await searchDocsExecute({ limit: 10, query: 'shared' }, customIndex);

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
        summary: 'Only ninth appears here.',
        title: 'Ninth',
      }),
      makeDoc({
        id: 'eighth-token',
        summary: 'Only eight appears here.',
        title: 'Eight',
      }),
    ];

    await expect(searchDocsExecute({ limit: 5, query: '   ' }, customIndex)).resolves.toMatchObject(
      {
        query: '',
        results: [],
        totalResults: 0,
      }
    );

    const response = await searchDocsExecute(
      { limit: 5, query: 'one two three four five six seven eight ninth' },
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
        sections: ['First section.', 'Second section.'],
        summary: 'Versioned summary.',
        tags: ['versioned'],
        title: 'Versioned Doc',
        url: '/versioned',
        versionIntroduced: '2026.06',
      }),
    ];

    const response = await docSummaryExecute({ docId: ' versioned ' }, customIndex);

    expect(response.doc).toEqual({
      id: 'versioned',
      sections: [
        { id: 'versioned-section-1', text: 'First section.' },
        { id: 'versioned-section-2', text: 'Second section.' },
      ],
      summary: 'Versioned summary.',
      tags: ['versioned'],
      title: 'Versioned Doc',
      url: '/versioned',
      versionIntroduced: '2026.06',
    });
  });

  it('omits version metadata when absent and throws for missing docs', async () => {
    const customIndex = [
      makeDoc({
        id: 'plain',
        sections: ['Only section.'],
        summary: 'Plain summary.',
        title: 'Plain Doc',
        url: '/plain',
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

it('counts Unicode code points at the query bounds on the installed validator contract', () => {
  expect(Schema.decodeUnknownResult(searchDocsInputSchema)({ query: '😀' })._tag).toBe('Failure');
  expect(Schema.decodeUnknownResult(searchDocsInputSchema)({ query: '😀'.repeat(200) })._tag).toBe(
    'Success'
  );
  expect(Schema.decodeUnknownResult(searchDocsInputSchema)({ query: '😀'.repeat(201) })._tag).toBe(
    'Failure'
  );
});
