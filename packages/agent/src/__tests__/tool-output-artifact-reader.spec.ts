import {
  decodeToolOutputArtifactContent,
  decodeToolOutputArtifactCursor,
  encodeToolOutputArtifactCursor,
  TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES,
  type ToolOutputArtifactReference,
} from '@brainstrike/assistant-contract/tool-output-artifact';
import { Schema, SchemaIssue } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import {
  decodedTextModelOutputChars,
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  resolveScaledToolResultBudget,
} from '../stream/tool-output-limits';
import {
  projectToolOutputArtifactPage,
  ReadToolOutputArtifactInputSchema,
  readToolOutputArtifact,
  readToolOutputArtifactPage,
  type ScopedToolOutputArtifactReader,
} from '../tool-projection/tool-output-artifact-reader';

const TEXT_ENCODER = new TextEncoder();
const NOW = new Date('2026-07-20T12:00:00.000Z');

function referenceFor(
  content: string,
  overrides: Partial<ToolOutputArtifactReference> = {}
): ToolOutputArtifactReference {
  return {
    byteLength: TEXT_ENCODER.encode(content).byteLength,
    expiresAt: '2026-07-27T12:00:00.000Z',
    format: 'text',
    id: '019f7d67-7165-7c23-8e99-d70c2a2f168d',
    ...overrides,
  };
}

function readerFor(
  content: string,
  artifactRef = referenceFor(content)
): ScopedToolOutputArtifactReader {
  const bytes = TEXT_ENCODER.encode(content);
  return {
    readRange: async ({ artifactId, limitBytes, offsetByte }) => {
      if (artifactId !== artifactRef.id) {
        return { status: 'not_found' };
      }
      const page = bytes.slice(offsetByte, offsetByte + limitBytes);
      return {
        bytes: page,
        endByte: offsetByte + page.byteLength,
        offsetByte,
        reference: artifactRef,
        status: 'found',
      };
    },
  };
}

/**
 * The repository rejects any read above TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES, so
 * a scan wider than one page must arrive as capped, contiguous reads that
 * together cover the scanned window exactly.
 */
function expectCappedContiguousReads(
  calls: ReadonlyArray<ReadonlyArray<{ limitBytes: number; offsetByte: number }>>,
  scannedBytes: number
): void {
  expect(calls.length).toBeGreaterThan(1);
  let nextOffset = 0;
  for (const [read] of calls) {
    expect(read?.limitBytes).toBeLessThanOrEqual(TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES);
    expect(read?.offsetByte).toBe(nextOffset);
    nextOffset += read?.limitBytes ?? 0;
  }
  expect(nextOffset).toBe(scannedBytes);
}

describe('tool output artifact reader', () => {
  it('uses a strict discriminant for initial references and continuation cursors', () => {
    const artifactRef = referenceFor('content');
    const cursor = encodeToolOutputArtifactCursor(artifactRef, 1);

    expect(
      Schema.decodeUnknownResult(ReadToolOutputArtifactInputSchema, { onExcessProperty: 'error' })({
        artifactRef,
        maxBytes: 4,
        mode: 'artifact',
      })._tag
    ).toBe('Success');
    expect(
      Schema.decodeUnknownResult(ReadToolOutputArtifactInputSchema, { onExcessProperty: 'error' })({
        cursor,
        maxBytes: 4,
        mode: 'cursor',
      })._tag
    ).toBe('Success');
    expect(
      Schema.decodeUnknownResult(ReadToolOutputArtifactInputSchema, { onExcessProperty: 'error' })({
        artifactRef,
        cursor,
        mode: 'artifact',
      })._tag
    ).toBe('Failure');
    expect(
      Schema.decodeUnknownResult(ReadToolOutputArtifactInputSchema, { onExcessProperty: 'error' })({
        cursor,
        mode: 'artifact',
      })._tag
    ).toBe('Failure');
  });

  it('concatenates multi-page UTF-8, CRLF, emoji, and U+0000 content byte-exactly', async () => {
    const content = 'A🙂\r\nB\u0000C🙂tail';
    const artifactRef = referenceFor(content);
    const reader = readerFor(content, artifactRef);
    const pages = [];
    let input: unknown = {
      artifactRef,
      maxBytes: 4,
      mode: 'artifact',
    };

    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const page = await readToolOutputArtifactPage(input, { now: () => NOW, reader });
      pages.push(page);
      if (!page.nextCursor) {
        break;
      }
      expect(decodeToolOutputArtifactCursor(page.nextCursor)).toEqual({
        artifactRef,
        offsetByte: page.endByte,
      });
      input = {
        cursor: page.nextCursor,
        maxBytes: 4,
        mode: 'cursor',
      };
    }

    expect(pages.at(-1)?.nextCursor).toBeUndefined();
    expect(pages.map((page) => page.offsetByte)).toEqual(
      pages.map((_page, index) => (index === 0 ? 0 : pages[index - 1]?.endByte))
    );
    const recovered = pages
      .map((page) => decodeToolOutputArtifactContent(page.content, page.contentEncoding))
      .join('');
    expect(TEXT_ENCODER.encode(recovered)).toEqual(TEXT_ENCODER.encode(content));
    expect(pages.some((page) => page.contentEncoding === 'json-string')).toBe(true);
  });

  it('preserves a UTF-8 BOM as artifact content', async () => {
    const content = '\uFEFFabc';
    const artifactRef = referenceFor(content);
    const page = await readToolOutputArtifactPage(
      { artifactRef, maxBytes: 4, mode: 'artifact' },
      { now: () => NOW, reader: readerFor(content, artifactRef) }
    );

    expect(decodeToolOutputArtifactContent(page.content, page.contentEncoding)).toBe('\uFEFFa');
    expect(page.endByte).toBe(4);
  });

  it('requests no bytes beyond the configured page size', async () => {
    const content = 'abcdefgh';
    const artifactRef = referenceFor(content);
    const reader = readerFor(content, artifactRef);
    const readRange = vi.spyOn(reader, 'readRange');

    await readToolOutputArtifactPage(
      { artifactRef, maxBytes: 4, mode: 'artifact' },
      { now: () => NOW, reader }
    );

    expect(readRange).toHaveBeenCalledWith({
      artifactId: artifactRef.id,
      limitBytes: 4,
      offsetByte: 0,
    });
  });

  it('continues from a settlement cursor and omits a cursor at the exact boundary', async () => {
    const content = 'preview-tail';
    const artifactRef = referenceFor(content);
    const offsetByte = TEXT_ENCODER.encode('preview-').byteLength;
    const page = await readToolOutputArtifactPage(
      {
        cursor: encodeToolOutputArtifactCursor(artifactRef, offsetByte),
        maxBytes: 8,
        mode: 'cursor',
      },
      { now: () => NOW, reader: readerFor(content, artifactRef) }
    );

    expect(page).toMatchObject({
      artifactRef,
      content: 'tail',
      endByte: artifactRef.byteLength,
      offsetByte,
    });
    expect(page.nextCursor).toBeUndefined();
  });

  it('returns one valid terminal page for an empty artifact', async () => {
    const artifactRef = referenceFor('');
    const page = await readToolOutputArtifactPage(
      { artifactRef, mode: 'artifact' },
      { now: () => NOW, reader: readerFor('', artifactRef) }
    );

    expect(page).toEqual({
      artifactRef,
      content: '',
      endByte: 0,
      offsetByte: 0,
    });
  });

  it('surfaces malformed cursors and invalid inputs as typed failures', async () => {
    const reader = readerFor('content');

    await expect(
      readToolOutputArtifactPage(
        { cursor: 'bsto1.not-a-cursor', mode: 'cursor' },
        { now: () => NOW, reader }
      )
    ).rejects.toMatchObject({ reason: 'malformed_cursor' });
    await expect(
      readToolOutputArtifactPage(
        { artifactRef: referenceFor('content'), cursor: 'extra', mode: 'artifact' },
        { now: () => NOW, reader }
      )
    ).rejects.toMatchObject({ reason: 'invalid_input' });
    await expect(
      readToolOutputArtifactPage(
        {
          cursor: encodeToolOutputArtifactCursor(referenceFor('content'), 1),
          maxBytes: 1,
          mode: 'cursor',
        },
        { now: () => NOW, reader }
      )
    ).rejects.toMatchObject({ reason: 'invalid_input' });
  });

  it('enforces the exact expiry boundary even when storage still reports found', async () => {
    const content = 'Complete recoverable evidence';
    const artifactRef = referenceFor(content);
    const input = { artifactRef, mode: 'artifact' } as const;
    const reader = readerFor(content, artifactRef);
    const expiresAt = Date.parse(artifactRef.expiresAt);
    expect(Number.isFinite(expiresAt)).toBe(true);

    await expect(
      readToolOutputArtifactPage(input, { now: () => new Date(expiresAt - 1), reader })
    ).resolves.toMatchObject({ content });
    await expect(
      readToolOutputArtifactPage(input, { now: () => new Date(expiresAt), reader })
    ).rejects.toMatchObject({ reason: 'artifact_expired' });
  });

  it('fails expired, wrong-scope, incoherent, non-progress, and storage reads visibly', async () => {
    const artifactRef = referenceFor('content');
    const input = { artifactRef, mode: 'artifact' } as const;

    await expect(
      readToolOutputArtifactPage(input, {
        now: () => NOW,
        reader: { readRange: async () => ({ reference: artifactRef, status: 'expired' }) },
      })
    ).rejects.toMatchObject({ reason: 'artifact_expired' });

    await expect(
      readToolOutputArtifactPage(input, {
        now: () => NOW,
        reader: { readRange: async () => ({ status: 'not_found' }) },
      })
    ).rejects.toMatchObject({ reason: 'artifact_not_found' });

    await expect(
      readToolOutputArtifactPage(input, {
        now: () => NOW,
        reader: readerFor('content', { ...artifactRef, format: 'json' }),
      })
    ).rejects.toMatchObject({ reason: 'artifact_incoherent' });

    await expect(
      readToolOutputArtifactPage(input, {
        now: () => NOW,
        reader: {
          readRange: async () => ({
            bytes: new Uint8Array(),
            endByte: 0,
            offsetByte: 0,
            reference: artifactRef,
            status: 'found',
          }),
        },
      })
    ).rejects.toMatchObject({ reason: 'non_progress' });

    const storageError = new Error('database unavailable');
    await expect(
      readToolOutputArtifactPage(input, {
        now: () => NOW,
        reader: {
          readRange: vi.fn(async () => {
            throw storageError;
          }),
        },
      })
    ).rejects.toMatchObject({ cause: storageError, reason: 'storage_failed' });
  });

  it('rejects malformed UTF-8 and incoherent byte ranges from storage', async () => {
    const artifactRef = referenceFor('abcd');
    const invalidUtf8 = Uint8Array.from([0xf0, 0x28, 0x8c, 0x28]);

    await expect(
      readToolOutputArtifactPage(
        { artifactRef, maxBytes: 4, mode: 'artifact' },
        {
          now: () => NOW,
          reader: {
            readRange: async () => ({
              bytes: invalidUtf8,
              endByte: invalidUtf8.byteLength,
              offsetByte: 0,
              reference: artifactRef,
              status: 'found',
            }),
          },
        }
      )
    ).rejects.toMatchObject({ reason: 'artifact_incoherent' });
  });

  it('projects an escape-heavy raw page within budget using an exact shorter cursor', async () => {
    const content = `head${'\u0000'.repeat(2000)}tail`;
    const artifactRef = referenceFor(content);
    const rawPage = await readToolOutputArtifactPage(
      { artifactRef, maxBytes: 8000, mode: 'artifact' },
      { now: () => NOW, reader: readerFor(content, artifactRef) }
    );

    const projection = projectToolOutputArtifactPage(rawPage);
    expect(JSON.stringify(projection).length).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(projection.value.next?.tool).toBe('brainstrike.readToolOutputArtifact');
    const projectedContent = decodeToolOutputArtifactContent(
      projection.value.content,
      projection.value.contentEncoding
    );
    expect(content.startsWith(projectedContent)).toBe(true);
    expect(decodeToolOutputArtifactCursor(projection.value.next?.input.cursor ?? '')).toEqual({
      artifactRef,
      offsetByte: TEXT_ENCODER.encode(projectedContent).byteLength,
    });
    expect(projection.value.endByte).toBe(TEXT_ENCODER.encode(projectedContent).byteLength);
  });

  it('keeps a fitting terminal page whole even when a shorter cursor-bearing page does not fit', () => {
    const content = 'x'.repeat(5800);
    const artifactRef = referenceFor(content);
    const rawPage = {
      artifactRef,
      content,
      endByte: artifactRef.byteLength,
      offsetByte: 0,
    };

    const projection = projectToolOutputArtifactPage(rawPage);

    expect(JSON.stringify(projection).length).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
    expect(projection.value).toMatchObject({
      complete: true,
      content,
      endByte: artifactRef.byteLength,
      offsetByte: 0,
    });
    expect(projection.value.next).toBeUndefined();
  });

  it('fits an artifact page to a floor-tier resolved domain budget', () => {
    const content = 'x'.repeat(5800);
    const artifactRef = referenceFor(content);
    const rawPage = {
      artifactRef,
      content,
      endByte: artifactRef.byteLength,
      offsetByte: 0,
    };
    const floorBudget = resolveScaledToolResultBudget(8192).domainModelResultCharBudget;

    const projection = projectToolOutputArtifactPage(rawPage, floorBudget);

    expect(JSON.stringify(projection).length).toBeLessThanOrEqual(floorBudget);
    expect(projection.value.content.length).toBeLessThan(content.length);
    expect(projection.value.next?.tool).toBe('brainstrike.readToolOutputArtifact');
  });

  it('keeps an anchor-tier artifact page byte-identical to the default projection', () => {
    const content = `head${'\\'.repeat(2000)}tail`;
    const artifactRef = referenceFor(content);
    const rawPage = {
      artifactRef,
      content,
      endByte: artifactRef.byteLength,
      offsetByte: 0,
    };

    expect(
      projectToolOutputArtifactPage(rawPage, MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET)
    ).toEqual(projectToolOutputArtifactPage(rawPage));
  });

  it('searches a bounded artifact slice and projects matching lines in compact grep format', async () => {
    const content = ['alpha', 'Needle first', 'beta', 'second needle'].join('\n');
    const artifactRef = referenceFor(content);
    const result = await readToolOutputArtifact(
      {
        cursor: encodeToolOutputArtifactCursor(artifactRef, 0),
        mode: 'cursor',
        pattern: 'needle',
      },
      { now: () => NOW, reader: readerFor(content, artifactRef) }
    );

    expect(projectToolOutputArtifactPage(result)).toEqual({
      type: 'text',
      value: [
        'grep content 1-2/2',
        `artifact bytes 0-${artifactRef.byteLength}`,
        '  2: Needle first',
        '  4: second needle',
      ].join('\n'),
    });
  });

  it('returns a valid empty grep projection for a complete zero-match search', async () => {
    const content = 'alpha\nbeta\ngamma';
    const artifactRef = referenceFor(content);
    const result = await readToolOutputArtifact(
      {
        cursor: encodeToolOutputArtifactCursor(artifactRef, 0),
        mode: 'cursor',
        pattern: 'missing',
      },
      { now: () => NOW, reader: readerFor(content, artifactRef) }
    );

    const projection = projectToolOutputArtifactPage(result);
    expect(projection).toEqual({
      type: 'text',
      value: ['grep content empty@offset=0/0', `artifact bytes 0-${artifactRef.byteLength}`].join(
        '\n'
      ),
    });
    expect(projection.value).not.toContain('continue:');
  });

  it('fits oversized match sets with an actionable cursor and rejects silent limitation', async () => {
    const content = Array.from(
      { length: 12 },
      (_, index) => `match-${index}-${'x'.repeat(620)}`
    ).join('\n');
    const artifactRef = referenceFor(content);
    const result = await readToolOutputArtifact(
      {
        cursor: encodeToolOutputArtifactCursor(artifactRef, 0),
        maxBytes: 8000,
        mode: 'cursor',
        pattern: 'match-',
      },
      { now: () => NOW, reader: readerFor(content, artifactRef) }
    );
    const projection = projectToolOutputArtifactPage(result);

    expect(projection.type).toBe('text');
    expect(projection.value).toContain(
      'continue: reuse the prior brainstrike.readToolOutputArtifact search input with cursor=bsto1.'
    );
    expect(Array.from(projection.value).length + 26).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );

    if (!('searchLimited' in result)) {
      throw new TypeError('Expected a search result.');
    }
    const { nextCursor: _nextCursor, ...withoutContinuation } = result;
    expect(() =>
      projectToolOutputArtifactPage({
        ...withoutContinuation,
        matches: [],
        searchLimited: true,
      })
    ).toThrow(
      'Tool output artifact search projection received a limited result without continuation guidance'
    );
  });

  it('fits artifact search rows to a floor-tier resolved domain budget', async () => {
    const content = Array.from(
      { length: 12 },
      (_, index) => `match-${index}-${'x'.repeat(620)}`
    ).join('\n');
    const artifactRef = referenceFor(content);
    const result = await readToolOutputArtifact(
      {
        cursor: encodeToolOutputArtifactCursor(artifactRef, 0),
        maxBytes: 8000,
        mode: 'cursor',
        pattern: 'match-',
      },
      { now: () => NOW, reader: readerFor(content, artifactRef) }
    );
    const floorBudget = resolveScaledToolResultBudget(8192).domainModelResultCharBudget;

    const projection = projectToolOutputArtifactPage(result, floorBudget);

    expect(decodedTextModelOutputChars(projection.value)).toBeLessThanOrEqual(floorBudget);
    expect(projection.value).toContain('continue:');
  });

  it('supports regex matching and independently controls case sensitivity', async () => {
    const content = ['ERROR-17', 'error-23', 'plain'].join('\n');
    const artifactRef = referenceFor(content);
    const cursor = encodeToolOutputArtifactCursor(artifactRef, 0);
    const reader = readerFor(content, artifactRef);

    const regex = projectToolOutputArtifactPage(
      await readToolOutputArtifact(
        { cursor, isRegex: true, mode: 'cursor', pattern: '^error-\\d+$' },
        { now: () => NOW, reader }
      )
    );
    expect(regex.value).toContain('  1: ERROR-17');
    expect(regex.value).toContain('  2: error-23');

    const caseSensitive = projectToolOutputArtifactPage(
      await readToolOutputArtifact(
        { caseSensitive: true, cursor, mode: 'cursor', pattern: 'error-' },
        { now: () => NOW, reader }
      )
    );
    expect(caseSensitive.value).not.toContain('  1: ERROR-17');
    expect(caseSensitive.value).toContain('  2: error-23');

    const caseInsensitive = projectToolOutputArtifactPage(
      await readToolOutputArtifact(
        { caseSensitive: false, cursor, mode: 'cursor', pattern: 'error-' },
        { now: () => NOW, reader }
      )
    );
    expect(caseInsensitive.value).toContain('  1: ERROR-17');
    expect(caseInsensitive.value).toContain('  2: error-23');
  });

  it('does not mutate cursor paging when a search is interleaved', async () => {
    const content = 'head-needle-middle-tail';
    const artifactRef = referenceFor(content);
    const reader = readerFor(content, artifactRef);
    const first = await readToolOutputArtifactPage(
      { artifactRef, maxBytes: 5, mode: 'artifact' },
      { now: () => NOW, reader }
    );
    if (!first.nextCursor) {
      throw new TypeError('Expected a continuation cursor.');
    }

    const expectedNext = await readToolOutputArtifactPage(
      { cursor: first.nextCursor, maxBytes: 8, mode: 'cursor' },
      { now: () => NOW, reader }
    );
    // This artifact has no line breaks, so a search maxBytes smaller than the
    // remaining content would land mid-line with no boundary to align to
    // (the single-giant-line guard); use a maxBytes that reaches the true
    // end so the interleaved search itself succeeds, independent of that
    // guard, while still exercising the plain-paging state below with its
    // own small maxBytes.
    const search = await readToolOutputArtifact(
      { cursor: first.nextCursor, maxBytes: 100, mode: 'cursor', pattern: 'needle' },
      { now: () => NOW, reader }
    );
    expect(projectToolOutputArtifactPage(search).value).toContain('  1: needle-m');

    const resumed = await readToolOutputArtifactPage(
      { cursor: first.nextCursor, maxBytes: 8, mode: 'cursor' },
      { now: () => NOW, reader }
    );
    expect(resumed).toEqual(expectedNext);
    expect(
      decodeToolOutputArtifactContent(first.content, first.contentEncoding) +
        decodeToolOutputArtifactContent(resumed.content, resumed.contentEncoding)
    ).toBe('head-needle-m');
  });

  it('rejects a catastrophic-backtracking regex pattern before compiling it, with a pattern-specific reason and message (no silent literal fallback, never confusable with a bad cursor)', async () => {
    const content =
      'safe content with no pathological input, aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!';
    const artifactRef = referenceFor(content);

    await expect(
      readToolOutputArtifact(
        {
          cursor: encodeToolOutputArtifactCursor(artifactRef, 0),
          isRegex: true,
          mode: 'cursor',
          pattern: '^(a+)+$',
        },
        { now: () => NOW, reader: readerFor(content, artifactRef) }
      )
    ).rejects.toMatchObject({
      message: expect.stringContaining('catastrophic backtracking'),
      reason: 'invalid_search_pattern',
    });
  });

  it('rejects a syntactically invalid regex pattern at parse time (fail-fast, mirrors GrepSearchInputSchema)', async () => {
    const content = 'irrelevant';
    const artifactRef = referenceFor(content);

    const parsed = Schema.decodeUnknownResult(ReadToolOutputArtifactInputSchema, {
      onExcessProperty: 'error',
    })({
      cursor: encodeToolOutputArtifactCursor(artifactRef, 0),
      isRegex: true,
      mode: 'cursor',
      pattern: '(unterminated[',
    });
    expect(parsed._tag).toBe('Failure');
    if (parsed._tag === 'Success') {
      throw new TypeError('Expected schema parse to fail.');
    }
    expect(SchemaIssue.makeFormatterStandardSchemaV1()(parsed.failure.issue).issues).toContainEqual(
      expect.objectContaining({
        message: 'pattern is not a valid JavaScript regular expression (isRegex is true)',
        path: ['pattern'],
      })
    );

    await expect(
      readToolOutputArtifact(
        {
          cursor: encodeToolOutputArtifactCursor(artifactRef, 0),
          isRegex: true,
          mode: 'cursor',
          pattern: '(unterminated[',
        },
        { now: () => NOW, reader: readerFor(content, artifactRef) }
      )
    ).rejects.toMatchObject({
      message: expect.stringContaining('pattern is not a valid JavaScript regular expression'),
      reason: 'invalid_search_pattern',
    });
  });

  it('still matches with a safe regex pattern once the ReDoS guard is applied', async () => {
    const content = ['alpha-1', 'beta-2'].join('\n');
    const artifactRef = referenceFor(content);

    const result = await readToolOutputArtifact(
      {
        cursor: encodeToolOutputArtifactCursor(artifactRef, 0),
        isRegex: true,
        mode: 'cursor',
        pattern: '^alpha-\\d+$',
      },
      { now: () => NOW, reader: readerFor(content, artifactRef) }
    );
    if (!('matches' in result)) {
      throw new TypeError('Expected a search result.');
    }
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.lineText).toBe('alpha-1');
  });

  it('defers a line split by the maxBytes window instead of scanning a raw fragment, so a literal straddling the old byte boundary is found once the line is complete', async () => {
    const line1 = 'a'.repeat(20);
    const line2 = `${'b'.repeat(20)}NEEDLE${'c'.repeat(20)}`;
    const content = [line1, line2].join('\n');
    const artifactRef = referenceFor(content);
    const reader = readerFor(content, artifactRef);

    // Raw byte cut lands 3 characters into "NEEDLE" (line1 + '\n' + 20 'b's +
    // "NEE"). Without line-boundary alignment this would split the literal
    // across two independent calls, and it would never be found by either.
    const first = await readToolOutputArtifact(
      {
        cursor: encodeToolOutputArtifactCursor(artifactRef, 0),
        maxBytes: line1.length + 1 + 20 + 3,
        mode: 'cursor',
        pattern: 'NEEDLE',
      },
      { now: () => NOW, reader }
    );
    if (!('matches' in first)) {
      throw new TypeError('Expected a search result.');
    }
    expect(first.matches).toHaveLength(0);
    expect(first.searchLimited).toBe(true);
    if (!first.nextCursor) {
      throw new TypeError('Expected a continuation cursor.');
    }

    const second = await readToolOutputArtifact(
      {
        cursor: first.nextCursor,
        maxBytes: line2.length + 10,
        mode: 'cursor',
        pattern: 'NEEDLE',
      },
      { now: () => NOW, reader }
    );
    if (!('matches' in second)) {
      throw new TypeError('Expected a search result.');
    }
    expect(second.matches).toHaveLength(1);
    expect(second.matches[0]?.lineText).toBe(line2);
    expect(second.searchLimited).toBe(false);
  });

  it('never matches ^/$ anchors against an artificial slice edge that is not the real line boundary', async () => {
    const line1 = 'a'.repeat(20);
    const line2 = `x${'NEEDLE'}${'y'.repeat(20)}`;
    const content = [line1, line2].join('\n');
    const artifactRef = referenceFor(content);

    const searchAcrossBothCalls = async (
      pattern: string,
      firstCallMaxBytes: number
    ): Promise<number> => {
      const reader = readerFor(content, artifactRef);
      const first = await readToolOutputArtifact(
        {
          cursor: encodeToolOutputArtifactCursor(artifactRef, 0),
          isRegex: true,
          maxBytes: firstCallMaxBytes,
          mode: 'cursor',
          pattern,
        },
        { now: () => NOW, reader }
      );
      if (!('matches' in first && first.nextCursor)) {
        throw new TypeError('Expected a limited search result with a continuation cursor.');
      }
      const second = await readToolOutputArtifact(
        {
          cursor: first.nextCursor,
          isRegex: true,
          maxBytes: line2.length + 10,
          mode: 'cursor',
          pattern,
        },
        { now: () => NOW, reader }
      );
      if (!('matches' in second)) {
        throw new TypeError('Expected a search result.');
      }
      return first.matches.length + second.matches.length;
    };

    // Cut right after the leading 'x', before 'N': a raw (unaligned) fragment
    // would start with "NEEDLE...", falsely satisfying ^NEEDLE even though
    // the real line starts with 'x'.
    expect(await searchAcrossBothCalls('^NEEDLE', line1.length + 1 + 1)).toBe(0);
    // Cut right after "NEEDLE", before the trailing 'y's: a raw (unaligned)
    // fragment would end with "...NEEDLE", falsely satisfying NEEDLE$ even
    // though the real line continues with more characters after NEEDLE.
    expect(await searchAcrossBothCalls('NEEDLE$', line1.length + 1 + 1 + 6)).toBe(0);
  });

  it('fails visibly when a single line exceeds the maxBytes scan window instead of silently scanning a fragment', async () => {
    const content = 'x'.repeat(9000);
    const artifactRef = referenceFor(content);

    await expect(
      readToolOutputArtifact(
        {
          cursor: encodeToolOutputArtifactCursor(artifactRef, 0),
          maxBytes: 100,
          mode: 'cursor',
          pattern: 'x',
        },
        { now: () => NOW, reader: readerFor(content, artifactRef) }
      )
    ).rejects.toMatchObject({ reason: 'invalid_input' });
  });

  it('does not hand a phantom empty final line to the matcher when a scanned slice ends exactly at a line break, while a genuine blank line mid-content still matches', async () => {
    const trailingBreakContent = 'foo\nbar\n';
    const trailingBreakRef = referenceFor(trailingBreakContent);
    const trailingBreakResult = await readToolOutputArtifact(
      {
        cursor: encodeToolOutputArtifactCursor(trailingBreakRef, 0),
        isRegex: true,
        mode: 'cursor',
        pattern: '^$',
      },
      { now: () => NOW, reader: readerFor(trailingBreakContent, trailingBreakRef) }
    );
    if (!('matches' in trailingBreakResult)) {
      throw new TypeError('Expected a search result.');
    }
    expect(trailingBreakResult.matches).toHaveLength(0);

    const midBlankLineContent = 'foo\n\nbar';
    const midBlankLineRef = referenceFor(midBlankLineContent);
    const midBlankLineResult = await readToolOutputArtifact(
      {
        cursor: encodeToolOutputArtifactCursor(midBlankLineRef, 0),
        isRegex: true,
        mode: 'cursor',
        pattern: '^$',
      },
      { now: () => NOW, reader: readerFor(midBlankLineContent, midBlankLineRef) }
    );
    if (!('matches' in midBlankLineResult)) {
      throw new TypeError('Expected a search result.');
    }
    expect(midBlankLineResult.matches).toHaveLength(1);
    expect(midBlankLineResult.matches[0]?.line).toBe(2);
    expect(midBlankLineResult.matches[0]?.lineText).toBe('');
  });

  it('scans a multi-page-sized artifact in ONE call (as capped page reads) and finds a deep match, decoupled from the page/projection byte budget', async () => {
    const filler = Array.from(
      { length: 300 },
      (_, index) => `line-${index}-${'x'.repeat(50)}`
    ).join('\n');
    const content = `${filler}\nDEEPMATCH-here\n${filler}`;
    const artifactRef = referenceFor(content);
    expect(artifactRef.byteLength).toBeGreaterThan(TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES);
    const reader = readerFor(content, artifactRef);
    const readRange = vi.spyOn(reader, 'readRange');

    const result = await readToolOutputArtifact(
      {
        cursor: encodeToolOutputArtifactCursor(artifactRef, 0),
        mode: 'cursor',
        pattern: 'DEEPMATCH',
      },
      { now: () => NOW, reader }
    );
    if (!('matches' in result)) {
      throw new TypeError('Expected a search result.');
    }
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.lineText).toBe('DEEPMATCH-here');
    expect(result.searchLimited).toBe(false);

    expectCappedContiguousReads(readRange.mock.calls, artifactRef.byteLength);
  });

  it('still bounds rendered matches to the projection budget with continuation when a large scan overflows it', async () => {
    const line = (index: number) => `match-${index}-${'y'.repeat(620)}`;
    const content = Array.from({ length: 20 }, (_, index) => line(index)).join('\n');
    const artifactRef = referenceFor(content);
    const reader = readerFor(content, artifactRef);
    const readRange = vi.spyOn(reader, 'readRange');

    const result = await readToolOutputArtifact(
      {
        cursor: encodeToolOutputArtifactCursor(artifactRef, 0),
        mode: 'cursor',
        pattern: 'match-',
      },
      { now: () => NOW, reader }
    );
    if (!('matches' in result)) {
      throw new TypeError('Expected a search result.');
    }
    // The whole artifact was scanned in one call (decoupled scan window)...
    expect(result.matches.length).toBe(20);
    expect(result.searchLimited).toBe(false);
    expectCappedContiguousReads(readRange.mock.calls, artifactRef.byteLength);

    // ...but the PROJECTION still fits the domain budget and hints a
    // continuation for the matches it could not render, exactly like a
    // budget-limited page.
    const projection = projectToolOutputArtifactPage(result);
    expect(projection.value).toContain(
      'continue: reuse the prior brainstrike.readToolOutputArtifact search input with cursor='
    );
    expect(decodedTextModelOutputChars(projection.value)).toBeLessThanOrEqual(
      MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET
    );
  });
});
