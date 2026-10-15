import {
  decodeToolOutputArtifactCursor,
  encodeToolOutputArtifactCursor,
  TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES,
  type ToolOutputArtifactReference,
} from '@brainstrike/assistant-contract/tool-output-artifact';
import {
  MigrationRunner,
  migrations,
  ToolOutputArtifactRepository,
  wasmLoader,
} from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  projectToolOutputArtifactPage,
  readToolOutputArtifact,
  type ScopedToolOutputArtifactReader,
  type ToolOutputArtifactSearchResult,
} from '../tool-projection/tool-output-artifact-reader';

const NOW = new Date('2026-07-20T12:00:00.000Z');
const RESOURCE_ID = 'resource-artifact-search';
const THREAD_ID = 'thread-artifact-search';
/** The search's total scan bound per call: 16 repository pages (unchanged). */
const SEARCH_SCAN_BOUND_BYTES = TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES * 16;

/** One real line = 99 filler bytes + "\n" = 100 bytes, so offsets are easy to reason about. */
function lineOf(text: string): string {
  return `${text}${'.'.repeat(99 - text.length)}`;
}

function contentOf(lines: number, tokenAtLine: number, token: string): string {
  return Array.from({ length: lines }, (_, index) =>
    lineOf(index === tokenAtLine ? token : `filler-${index}`)
  ).join('\n');
}

describe('tool output artifact reader against the real repository', () => {
  let db: PGlite;
  let repository: ToolOutputArtifactRepository;
  let reader: ScopedToolOutputArtifactReader;
  let readRange: ReturnType<typeof vi.fn<ScopedToolOutputArtifactReader['readRange']>>;
  let toolCallSeq = 0;

  beforeAll(async () => {
    db = await wasmLoader.createPGlite('memory://');
    const runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);
    repository = new ToolOutputArtifactRepository(db, { now: () => new Date(NOW) });
    // Same scoping the desktop host applies in stream-init.ts: the model never
    // supplies the ownership ids, the reader closure does.
    readRange = vi.fn((input) =>
      repository.readRange({ ...input, resourceId: RESOURCE_ID, threadId: THREAD_ID })
    );
    reader = { readRange };
  });

  beforeEach(() => {
    readRange.mockClear();
  });

  afterAll(async () => {
    await db?.close();
  });

  async function storeText(content: string) {
    toolCallSeq += 1;
    return await repository.store({
      content,
      format: 'text',
      resourceId: RESOURCE_ID,
      runId: 'run-artifact-search',
      threadId: THREAD_ID,
      toolCallId: `call-${toolCallSeq}`,
    });
  }

  async function search(
    artifactRef: ToolOutputArtifactReference,
    pattern: string,
    options: { isRegex?: boolean; offsetByte?: number } = {}
  ): Promise<ToolOutputArtifactSearchResult> {
    const result = await readToolOutputArtifact(
      {
        cursor: encodeToolOutputArtifactCursor(artifactRef, options.offsetByte ?? 0),
        ...(options.isRegex ? { isRegex: true } : {}),
        mode: 'cursor',
        pattern,
      },
      { now: () => NOW, reader }
    );
    if (!('matches' in result)) {
      throw new TypeError('Expected a search result.');
    }
    return result;
  }

  function readWindows(): Array<{ limitBytes: number; offsetByte: number }> {
    return readRange.mock.calls.map(([{ limitBytes, offsetByte }]) => ({ limitBytes, offsetByte }));
  }

  it('finds a pattern match deeper than the first repository page in a ~30 KB artifact', async () => {
    const token = 'UNIQUE_DEEP_TOKEN_20K';
    const artifactRef = await storeText(contentOf(300, 200, token));
    expect(artifactRef.byteLength).toBeGreaterThan(29_000);

    const result = await search(artifactRef, token);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.lineText).toContain(token);
    expect(result.matches[0]?.line).toBe(201);
    expect(result.matches[0]?.offsetByte).toBe(20_000);
    expect(result.searchLimited).toBe(false);
    expect(result.nextCursor).toBeUndefined();
  });

  it('finds a literal and an anchored regex match that straddle the 8,000-byte page boundary', async () => {
    const token = 'STRADDLE_TOKEN';
    // The second line starts at byte 7,901, so the token occupies bytes
    // 7,996..8,009 and is cut in two by the first repository page.
    const artifactRef = await storeText(
      `${'p'.repeat(7900)}\n${'q'.repeat(95)}${token}${'r'.repeat(50)}\nafter`
    );

    const literal = await search(artifactRef, token);
    expect(readWindows()).toEqual([
      { limitBytes: TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES, offsetByte: 0 },
      {
        limitBytes: artifactRef.byteLength - TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES,
        offsetByte: TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES,
      },
    ]);
    expect(literal.matches).toHaveLength(1);
    expect(literal.matches[0]).toMatchObject({ line: 2, offsetByte: 7901 });
    expect(literal.matches[0]?.lineText).toBe(`${'q'.repeat(95)}${token}${'r'.repeat(50)}`);

    // ^ and $ must see the real line edges, not a page edge.
    const anchored = await search(artifactRef, `^q{95}${token}r{50}$`, { isRegex: true });
    expect(anchored.matches).toHaveLength(1);
    expect(anchored.matches[0]?.line).toBe(2);
  });

  it('decodes a multi-byte character cut in two by the page boundary', async () => {
    // The four-byte emoji occupies bytes 7,998..8,001, so the first repository
    // page ends inside it and cannot be decoded on its own.
    const artifactRef = await storeText(`${'a'.repeat(7998)}\u{1F642}\nEMOJI_SEAM_TOKEN`);

    const emoji = await search(artifactRef, '\u{1F642}');
    const token = await search(artifactRef, 'EMOJI_SEAM_TOKEN');

    expect(emoji.matches).toHaveLength(1);
    expect(emoji.matches[0]?.lineText.endsWith('\u{1F642}')).toBe(true);
    expect(token.matches).toHaveLength(1);
    expect(token.matches[0]).toMatchObject({ line: 2, offsetByte: 8003 });
    expect(token.searchLimited).toBe(false);
  });

  it('does not find a match beyond the 128,000-byte scan bound and reports the bounded scan with a cursor', async () => {
    const token = 'BEYOND_THE_BOUND';
    // 1,400 lines x 100 bytes; the token sits at byte 135,000.
    const artifactRef = await storeText(contentOf(1400, 1350, token));
    expect(artifactRef.byteLength).toBeGreaterThan(SEARCH_SCAN_BOUND_BYTES + 8000);

    const bounded = await search(artifactRef, token);

    expect(bounded.matches).toHaveLength(0);
    expect(bounded.searchLimited).toBe(true);
    expect(bounded.endByte).toBe(SEARCH_SCAN_BOUND_BYTES);
    expect(bounded.nextCursor).toBeDefined();
    expect(readWindows()).toHaveLength(16);
    expect(Math.max(...readWindows().map((window) => window.limitBytes))).toBe(
      TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES
    );
    expect(projectToolOutputArtifactPage(bounded).value).toContain(
      'continue: reuse the prior brainstrike.readToolOutputArtifact search input with cursor='
    );

    // The unscanned tail is not lost: the reported cursor resumes the scan.
    const resumed = await search(artifactRef, token, {
      offsetByte: decodeToolOutputArtifactCursor(bounded.nextCursor ?? '').offsetByte,
    });
    expect(resumed.matches).toHaveLength(1);
    expect(resumed.matches[0]?.lineText).toContain(token);
    expect(resumed.searchLimited).toBe(false);
  });

  it('still searches an artifact smaller than one page in a single repository read', async () => {
    const token = 'SMALL_ARTIFACT_TOKEN';
    const artifactRef = await storeText(`first\n${token}\nlast`);
    expect(artifactRef.byteLength).toBeLessThan(TOOL_OUTPUT_ARTIFACT_MAX_PAGE_BYTES);

    const result = await search(artifactRef, token);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ line: 2, lineText: token });
    expect(result.searchLimited).toBe(false);
    expect(readWindows()).toEqual([{ limitBytes: artifactRef.byteLength, offsetByte: 0 }]);
  });
});
