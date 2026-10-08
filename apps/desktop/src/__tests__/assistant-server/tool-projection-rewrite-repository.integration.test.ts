import {
  type ToolProjectionRewriteEntry,
  ToolProjectionRewriteProcessor,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import {
  grepProjectionHeaderPrefix,
  projectReadWorkspaceFileModelOutput,
  readProjectionHeaderPrefix,
} from '@brainstrike/host-capabilities/native-tools';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildGrepSupersededMarker,
  createToolProjectionRewriteLookup,
  recordSuccessfulToolProjection,
  TOOL_PROJECTION_REWRITE_BATCH_THRESHOLD_CHARS,
} from '../../assistant-server/tool-projection-rewrite-repository';

// apps/desktop does not (and must not) depend on @mastra/core directly — the
// mastra-boundary contract keeps Mastra Node-only and embedded inside
// packages/agent. Derive the processor's own request-arg shape structurally
// from the already-imported `ToolProjectionRewriteProcessor` instead of
// importing '@mastra/core/processors' here.
type ProcessLLMRequestArgs = Parameters<ToolProjectionRewriteProcessor['processLLMRequest']>[0];

function invocation(args: {
  readonly id: string;
  readonly input: Record<string, unknown>;
  readonly modelOutput?: unknown;
  readonly result: unknown;
  readonly toolName: string;
}): string {
  return JSON.stringify({
    content: [
      {
        providerMetadata: {
          mastra: {
            modelOutput: args.modelOutput ?? {
              type: 'text',
              value: JSON.stringify(args.result),
            },
          },
        },
        toolInvocation: {
          args: args.input,
          result: args.result,
          state: 'result',
          toolCallId: args.id,
          toolName: args.toolName.replace('.', '_'),
        },
        type: 'tool-invocation',
      },
    ],
    format: 2,
  });
}

async function insertMessage(
  db: PGlite,
  args: Parameters<typeof invocation>[0],
  createdAt: string
): Promise<void> {
  await db.query(
    `INSERT INTO mastra_messages
      (id, thread_id, content, role, type, "createdAt", "resourceId")
     VALUES ($1, 'thread-1', $2::jsonb, 'assistant', 'v2', $3, 'resource-1')`,
    [`message-${args.id}`, invocation(args), createdAt]
  );
}

function readResult(contentLength: number, endLine = 100, overrides: Record<string, unknown> = {}) {
  return {
    approxOutputTokens: contentLength,
    content: 'x'.repeat(contentLength),
    endLine,
    nextCursor: null,
    omittedChars: 0,
    path: 'src/a.ts',
    rootId: 'root-a',
    rootName: 'workspace',
    size: contentLength,
    startLine: 1,
    tokenCount: null,
    totalLines: endLine,
    truncated: false,
    ...overrides,
  };
}

const LARGE_READ_CONTENT_CHARS = 5000;
const READS_TO_CROSS_BATCH_THRESHOLD = 14;

async function replayWithRewrites(
  lookup: {
    listActiveRewrites: (
      threadId: string
    ) => Promise<ReadonlyMap<string, ToolProjectionRewriteEntry>>;
  },
  calls: readonly { id: string; output: string; toolName: string }[]
): Promise<ProcessLLMRequestArgs['prompt']> {
  const prompt: ProcessLLMRequestArgs['prompt'] = calls.flatMap((call) => [
    {
      content: [
        { input: {}, toolCallId: call.id, toolName: call.toolName, type: 'tool-call' as const },
      ],
      role: 'assistant' as const,
    },
    {
      content: [
        {
          output: { type: 'text' as const, value: call.output },
          toolCallId: call.id,
          toolName: call.toolName,
          type: 'tool-result' as const,
        },
      ],
      role: 'tool' as const,
    },
  ]);
  const result = await new ToolProjectionRewriteProcessor('thread-1', lookup).processLLMRequest({
    abort: (reason?: string): never => {
      throw new Error(reason ?? 'processor aborted');
    },
    model: {} as ProcessLLMRequestArgs['model'],
    prompt,
    retryCount: 0,
    state: {},
    stepNumber: 1,
    steps: [],
  });
  return result?.prompt ?? prompt;
}

async function insertLargeReads(
  db: PGlite,
  args: {
    idPrefix: string;
    input?: Record<string, unknown>;
    resultOverrides?: Record<string, unknown>;
    startMinute?: number;
  }
): Promise<void> {
  for (let index = 0; index < READS_TO_CROSS_BATCH_THRESHOLD; index += 1) {
    await insertMessage(
      db,
      {
        id: `${args.idPrefix}-${index}`,
        input: args.input ?? {
          endLine: 100,
          path: 'src/a.ts',
          root: 'root-a',
          startLine: 1,
        },
        result: readResult(LARGE_READ_CONTENT_CHARS, 100, args.resultOverrides),
        toolName: NATIVE_TOOL_ID.readWorkspaceFile,
      },
      new Date(Date.UTC(2026, 7, 8, 12, (args.startMinute ?? 0) + index)).toISOString()
    );
  }
}

describe('tool projection rewrite overlay', () => {
  let db: PGlite;
  const resetLoopGuards = vi.fn();
  const databaseProvider = async () => ({
    query: async <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) =>
      await db.query<T>(sql, params ? [...params] : undefined),
    transaction: async <T>(
      callback: (tx: {
        query: <TRow = Record<string, unknown>>(
          sql: string,
          params?: readonly unknown[]
        ) => Promise<{ rows: TRow[] }>;
      }) => Promise<T>
    ) =>
      await db.transaction(
        async (tx) =>
          await callback({
            query: async <TRow = Record<string, unknown>>(
              sql: string,
              params?: readonly unknown[]
            ) => await tx.query<TRow>(sql, params ? [...params] : undefined),
          })
      ),
  });

  beforeEach(async () => {
    db = new PGlite();
    resetLoopGuards.mockReset();
    await db.exec(`
      CREATE TABLE mastra_messages (
        id text PRIMARY KEY,
        thread_id text NOT NULL,
        content jsonb NOT NULL,
        role text NOT NULL,
        type text NOT NULL,
        "createdAt" timestamptz NOT NULL,
        "resourceId" text NOT NULL
      );
      CREATE TABLE brainstrike_assistant_message_tombstones (
        message_id text PRIMARY KEY,
        thread_id text NOT NULL,
        rewind_id text NOT NULL,
        tombstoned_at timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE TABLE brainstrike_assistant_tool_projection_rewrites (
        tool_call_id text PRIMARY KEY,
        thread_id text NOT NULL,
        rewrite_id text NOT NULL,
        superseded_by_tool_call_id text,
        kind text NOT NULL DEFAULT 'supersession'
          CHECK (kind IN ('supersession', 'prune')),
        marker_text text NOT NULL,
        original_chars integer NOT NULL CHECK (original_chars >= 0),
        created_at timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT brainstrike_tool_projection_rewrite_kind_superseder_check
          CHECK (
            (kind = 'supersession' AND superseded_by_tool_call_id IS NOT NULL)
            OR (kind = 'prune' AND superseded_by_tool_call_id IS NULL)
          )
      );
    `);
  });

  afterEach(async () => db.close());

  it('writes nothing below 64 KiB and commits one batch at or above it', async () => {
    await insertMessage(
      db,
      {
        id: 'call-small',
        input: { endLine: 100, path: 'src/a.ts', root: 'workspace', startLine: 1 },
        result: readResult(1000),
        toolName: NATIVE_TOOL_ID.readWorkspaceFile,
      },
      '2026-08-08T12:00:00Z'
    );
    await recordSuccessfulToolProjection(
      {
        input: { endLine: 100, path: 'src/a.ts', root: 'workspace', startLine: 1 },
        result: readResult(2000),
        runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
        toolCallId: 'call-new-small',
        toolId: NATIVE_TOOL_ID.readWorkspaceFile,
      },
      { getDatabase: databaseProvider, resetLoopGuards }
    );
    expect(
      (await db.query('SELECT * FROM brainstrike_assistant_tool_projection_rewrites')).rows
    ).toHaveLength(0);
    expect(resetLoopGuards).not.toHaveBeenCalled();

    await insertLargeReads(db, { idPrefix: 'call-large', startMinute: 1 });
    await recordSuccessfulToolProjection(
      {
        input: { endLine: 100, path: 'src/a.ts', root: 'workspace', startLine: 1 },
        result: readResult(2000),
        runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
        toolCallId: 'call-new-large',
        toolId: NATIVE_TOOL_ID.readWorkspaceFile,
      },
      { getDatabase: databaseProvider, resetLoopGuards }
    );

    const rows = await db.query<{ marker_text: string; rewrite_id: string }>(
      'SELECT marker_text, rewrite_id FROM brainstrike_assistant_tool_projection_rewrites ORDER BY tool_call_id'
    );
    expect(rows.rows).toHaveLength(READS_TO_CROSS_BATCH_THRESHOLD + 1);
    expect(new Set(rows.rows.map((row) => row.rewrite_id)).size).toBe(1);
    expect(rows.rows.every((row) => row.marker_text.startsWith(readProjectionHeaderPrefix()))).toBe(
      true
    );
    expect(resetLoopGuards).toHaveBeenCalledOnce();
    expect(resetLoopGuards).toHaveBeenCalledWith('thread-1');
  });

  it('builds both marker families from their canonical replay prefix helpers', () => {
    expect(buildGrepSupersededMarker('files').startsWith(grepProjectionHeaderPrefix('files'))).toBe(
      true
    );
    expect(readProjectionHeaderPrefix()).toBe('read ');
  });

  it('treats a successful file edit as superseding every earlier read of that file', async () => {
    await insertLargeReads(db, { idPrefix: 'read-before-edit' });

    await recordSuccessfulToolProjection(
      {
        input: { content: 'replacement', path: 'src/a.ts', root: 'workspace' },
        result: {
          bytesWritten: 11,
          created: false,
          path: 'src/a.ts',
          rootId: 'root-a',
          rootName: 'workspace',
        },
        runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
        toolCallId: 'edit-new',
        toolId: NATIVE_TOOL_ID.writeWorkspaceFile,
      },
      { getDatabase: databaseProvider, resetLoopGuards }
    );

    const rows = await db.query<{ marker_text: string; superseded_by_tool_call_id: string }>(
      'SELECT marker_text, superseded_by_tool_call_id FROM brainstrike_assistant_tool_projection_rewrites'
    );
    expect(rows.rows).toHaveLength(READS_TO_CROSS_BATCH_THRESHOLD);
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        {
          marker_text:
            'read src/a.ts lines 1-100/100 [superseded — file was modified after this read — re-read before relying on it]',
          superseded_by_tool_call_id: 'edit-new',
        },
      ])
    );
    expect(
      rows.rows.filter((row) => row.marker_text.includes('file was modified after this read'))
    ).toEqual([
      {
        marker_text:
          'read src/a.ts lines 1-100/100 [superseded — file was modified after this read — re-read before relying on it]',
        superseded_by_tool_call_id: 'edit-new',
      },
    ]);
    expect(resetLoopGuards).toHaveBeenCalledWith('thread-1');
  });

  it('does not merge same-name paths from different canonical workspace roots', async () => {
    await insertMessage(
      db,
      {
        id: 'read-root-a',
        input: { endLine: 100, path: 'src/a.ts', root: 'root-a', startLine: 1 },
        result: readResult(LARGE_READ_CONTENT_CHARS, 100, { rootId: 'root-a' }),
        toolName: NATIVE_TOOL_ID.readWorkspaceFile,
      },
      '2026-08-08T11:00:00Z'
    );
    await insertMessage(
      db,
      {
        id: 'read-root-b',
        input: { endLine: 100, path: 'src/a.ts', root: 'root-b', startLine: 1 },
        result: readResult(1000, 100, { rootId: 'root-b' }),
        toolName: NATIVE_TOOL_ID.readWorkspaceFile,
      },
      '2026-08-08T11:01:00Z'
    );
    await insertLargeReads(db, {
      idPrefix: 'root-filler-old',
      input: { endLine: 100, path: 'src/filler.ts', root: 'root-a', startLine: 1 },
      resultOverrides: { path: 'src/filler.ts', rootId: 'root-a' },
    });
    await insertMessage(
      db,
      {
        id: 'root-filler-new',
        input: { endLine: 100, path: 'src/filler.ts', root: 'root-a', startLine: 1 },
        result: readResult(1000, 100, { path: 'src/filler.ts', rootId: 'root-a' }),
        toolName: NATIVE_TOOL_ID.readWorkspaceFile,
      },
      '2026-08-08T12:30:00Z'
    );

    await recordSuccessfulToolProjection(
      {
        input: { content: 'unrelated', path: 'src/other.ts', root: 'root-a' },
        result: {
          bytesWritten: 9,
          created: false,
          path: 'src/other.ts',
          rootId: 'root-a',
          rootName: 'workspace',
        },
        runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
        toolCallId: 'root-trigger',
        toolId: NATIVE_TOOL_ID.writeWorkspaceFile,
      },
      { getDatabase: databaseProvider, resetLoopGuards }
    );

    const rows = await db.query<{ tool_call_id: string }>(
      'SELECT tool_call_id FROM brainstrike_assistant_tool_projection_rewrites'
    );
    expect(rows.rows).toHaveLength(READS_TO_CROSS_BATCH_THRESHOLD);
    expect(rows.rows.map((row) => row.tool_call_id)).not.toContain('read-root-a');
  });

  it('never lets a persisted unchanged-read stub supersede a real earlier read', async () => {
    await insertMessage(
      db,
      {
        id: 'read-real',
        input: { endLine: 100, path: 'src/a.ts', root: 'root-a', startLine: 1 },
        result: readResult(LARGE_READ_CONTENT_CHARS),
        toolName: NATIVE_TOOL_ID.readWorkspaceFile,
      },
      '2026-08-08T11:00:00Z'
    );
    await insertMessage(
      db,
      {
        id: 'read-dedup-stub',
        input: { endLine: 100, path: 'src/a.ts', root: 'root-a', startLine: 1 },
        result: readResult(44, 100, {
          content: 'File unchanged since the previous identical read.',
          dedup: true,
        }),
        toolName: NATIVE_TOOL_ID.readWorkspaceFile,
      },
      '2026-08-08T12:01:00Z'
    );
    await insertLargeReads(db, {
      idPrefix: 'filler-old',
      input: { endLine: 100, path: 'src/filler.ts', root: 'root-a', startLine: 1 },
      resultOverrides: { path: 'src/filler.ts' },
      startMinute: 2,
    });
    await insertMessage(
      db,
      {
        id: 'filler-new',
        input: { endLine: 100, path: 'src/filler.ts', root: 'root-a', startLine: 1 },
        result: readResult(1000, 100, { path: 'src/filler.ts' }),
        toolName: NATIVE_TOOL_ID.readWorkspaceFile,
      },
      '2026-08-08T12:30:00Z'
    );

    await recordSuccessfulToolProjection(
      {
        input: { content: 'unrelated', path: 'src/other.ts', root: 'root-a' },
        result: {
          bytesWritten: 9,
          created: false,
          path: 'src/other.ts',
          rootId: 'root-a',
          rootName: 'workspace',
        },
        runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
        toolCallId: 'unrelated-trigger',
        toolId: NATIVE_TOOL_ID.writeWorkspaceFile,
      },
      { getDatabase: databaseProvider, resetLoopGuards }
    );

    const rows = await db.query<{ tool_call_id: string }>(
      'SELECT tool_call_id FROM brainstrike_assistant_tool_projection_rewrites'
    );
    expect(rows.rows).toHaveLength(READS_TO_CROSS_BATCH_THRESHOLD);
    expect(rows.rows.map((row) => row.tool_call_id)).not.toContain('read-real');
  });

  it('uses the unambiguous multi-root label in collapsed read markers', async () => {
    await insertLargeReads(db, {
      idPrefix: 'read-labeled-root',
      resultOverrides: {
        ambiguousRootNames: [],
        openRoots: 2,
        rootId: 'root-a',
        rootName: 'workspace',
      },
    });

    await recordSuccessfulToolProjection(
      {
        input: { endLine: 100, path: 'src/a.ts', root: 'root-a', startLine: 1 },
        result: readResult(1000, 100, {
          ambiguousRootNames: [],
          openRoots: 2,
          rootId: 'root-a',
          rootName: 'workspace',
        }),
        runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
        toolCallId: 'read-labeled-root-later',
        toolId: NATIVE_TOOL_ID.readWorkspaceFile,
      },
      { getDatabase: databaseProvider, resetLoopGuards }
    );

    const rows = await db.query<{ marker_text: string }>(
      'SELECT marker_text FROM brainstrike_assistant_tool_projection_rewrites'
    );
    expect(rows.rows).toHaveLength(READS_TO_CROSS_BATCH_THRESHOLD);
    expect(
      rows.rows.every((row) => /^read workspace:src\/a\.ts lines/u.test(row.marker_text))
    ).toBe(true);
  });

  it('supersedes earlier greps only for the same normalized pattern and scope', async () => {
    const grepResult = {
      candidatesTruncated: false,
      files: Array.from({ length: 200 }, (_, index) => ({
        firstLine: 1,
        matchCount: 1,
        path: `src/${String(index).padStart(3, '0')}-${'long-name-'.repeat(15)}.ts`,
        source: 'live' as const,
      })),
      liveEngine: 'ripgrep' as const,
      offset: 0,
      outputMode: 'files' as const,
      scanLimited: false,
      totalFiles: 200,
      totalMatches: 200,
      truncated: false,
    };
    for (let index = 0; index < 20; index += 1) {
      await insertMessage(
        db,
        {
          id: `grep-old-${index}`,
          input: { filePaths: ['src'], outputMode: 'files', pattern: 'needle' },
          result: grepResult,
          toolName: NATIVE_TOOL_ID.grepSearch,
        },
        new Date(Date.UTC(2026, 7, 8, 12, index)).toISOString()
      );
    }

    await recordSuccessfulToolProjection(
      {
        input: { filePaths: ['src'], outputMode: 'files', pattern: 'needle' },
        result: { ...grepResult, files: [] },
        runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
        toolCallId: 'grep-new',
        toolId: NATIVE_TOOL_ID.grepSearch,
      },
      { getDatabase: databaseProvider, resetLoopGuards }
    );

    const rows = await db.query<{ marker_text: string }>(
      'SELECT marker_text FROM brainstrike_assistant_tool_projection_rewrites'
    );
    expect(rows.rows).toHaveLength(20);
    expect(
      rows.rows.every((row) => row.marker_text.startsWith(grepProjectionHeaderPrefix('files')))
    ).toBe(true);
  });

  it('normalizes wrapped persisted grep arguments before supersession matching', async () => {
    const grepResult = {
      candidatesTruncated: false,
      files: Array.from({ length: 300 }, (_, index) => ({
        firstLine: 1,
        matchCount: 1,
        path: `src/${String(index).padStart(3, '0')}-${'long-name-'.repeat(20)}.ts`,
        source: 'live' as const,
      })),
      liveEngine: 'ripgrep' as const,
      offset: 0,
      outputMode: 'files' as const,
      scanLimited: false,
      totalFiles: 300,
      totalMatches: 300,
      truncated: false,
    };
    for (let index = 0; index < 20; index += 1) {
      await insertMessage(
        db,
        {
          id: `grep-wrapped-${index}`,
          input: {
            context: { filePaths: ['src'], outputMode: 'files', pattern: 'wrapped-needle' },
          },
          result: grepResult,
          toolName: NATIVE_TOOL_ID.grepSearch,
        },
        new Date(Date.UTC(2026, 7, 8, 13, index)).toISOString()
      );
    }

    await recordSuccessfulToolProjection(
      {
        input: { filePaths: ['src'], outputMode: 'files', pattern: 'wrapped-needle' },
        result: { ...grepResult, files: [] },
        runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
        toolCallId: 'grep-wrapped-new',
        toolId: NATIVE_TOOL_ID.grepSearch,
      },
      { getDatabase: databaseProvider, resetLoopGuards }
    );

    expect(
      (await db.query('SELECT * FROM brainstrike_assistant_tool_projection_rewrites')).rows
    ).toHaveLength(20);
  });

  it('matches successful persisted greps with null omitted filePaths', async () => {
    const grepResult = {
      candidatesTruncated: false,
      files: Array.from({ length: 300 }, (_, index) => ({
        firstLine: 1,
        matchCount: 1,
        path: `src/${String(index).padStart(3, '0')}-${'long-name-'.repeat(20)}.ts`,
        source: 'live' as const,
      })),
      liveEngine: 'ripgrep' as const,
      offset: 0,
      outputMode: 'files' as const,
      scanLimited: false,
      totalFiles: 300,
      totalMatches: 300,
      truncated: false,
    };
    for (let index = 0; index < 20; index += 1) {
      await insertMessage(
        db,
        {
          id: `grep-null-scope-${index}`,
          input: { filePaths: null, outputMode: 'files', pattern: 'null-scope-needle' },
          result: grepResult,
          toolName: NATIVE_TOOL_ID.grepSearch,
        },
        new Date(Date.UTC(2026, 7, 8, 14, index)).toISOString()
      );
    }
    await insertMessage(
      db,
      {
        id: 'grep-malformed-required-pattern',
        input: { filePaths: null, outputMode: 'files', pattern: null },
        result: grepResult,
        toolName: NATIVE_TOOL_ID.grepSearch,
      },
      new Date(Date.UTC(2026, 7, 8, 14, 20)).toISOString()
    );

    await recordSuccessfulToolProjection(
      {
        input: { outputMode: 'files', pattern: 'null-scope-needle' },
        result: { ...grepResult, files: [] },
        runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
        toolCallId: 'grep-null-scope-new',
        toolId: NATIVE_TOOL_ID.grepSearch,
      },
      { getDatabase: databaseProvider, resetLoopGuards }
    );

    expect(
      (await db.query('SELECT * FROM brainstrike_assistant_tool_projection_rewrites')).rows
    ).toHaveLength(20);
  });

  it('batches reads by projected replay size rather than larger raw JSON size', async () => {
    const markerChars = JSON.stringify({
      type: 'text',
      value: 'read src/a.ts lines 1-100/100 [superseded — see the later read of this file]',
    }).length;
    let thresholdFixture:
      | { contentLength: number; count: number; result: ReturnType<typeof readResult> }
      | undefined;
    for (let count = 10; count <= 20 && !thresholdFixture; count += 1) {
      for (let contentLength = 4000; contentLength <= 5500; contentLength += 1) {
        const candidate = readResult(contentLength);
        const rawReclaimable =
          (JSON.stringify({ type: 'json', value: candidate }).length - markerChars) * count;
        const projectedReclaimable =
          (JSON.stringify(projectReadWorkspaceFileModelOutput(candidate)).length - markerChars) *
          count;
        if (
          rawReclaimable >= TOOL_PROJECTION_REWRITE_BATCH_THRESHOLD_CHARS &&
          projectedReclaimable < TOOL_PROJECTION_REWRITE_BATCH_THRESHOLD_CHARS
        ) {
          thresholdFixture = { contentLength, count, result: candidate };
          break;
        }
      }
    }
    if (!thresholdFixture) {
      throw new Error('Expected a read fixture that crosses only the raw-JSON threshold.');
    }
    for (let index = 0; index < thresholdFixture.count; index += 1) {
      await insertMessage(
        db,
        {
          id: `read-raw-only-threshold-${index}`,
          input: { endLine: 100, path: 'src/a.ts', root: 'root-a', startLine: 1 },
          // BST-1249: production persists the PROJECTED model output, and
          // measurement now reads it directly — the raw-JSON default fixture
          // would claim the model actually saw the raw JSON.
          modelOutput: projectReadWorkspaceFileModelOutput(thresholdFixture.result),
          result: thresholdFixture.result,
          toolName: NATIVE_TOOL_ID.readWorkspaceFile,
        },
        new Date(Date.UTC(2026, 7, 8, 14, index)).toISOString()
      );
    }

    await recordSuccessfulToolProjection(
      {
        input: { endLine: 100, path: 'src/a.ts', root: 'root-a', startLine: 1 },
        result: readResult(1000),
        runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
        toolCallId: 'read-after-raw-only-threshold',
        toolId: NATIVE_TOOL_ID.readWorkspaceFile,
      },
      { getDatabase: databaseProvider, resetLoopGuards }
    );

    expect(
      (await db.query('SELECT * FROM brainstrike_assistant_tool_projection_rewrites')).rows
    ).toHaveLength(0);
  });

  it('prunes only old read-only projections without mutating raw history or reviving on rewind', async () => {
    // grepSearch is read-only-allowlisted and therefore eligible; runPython
    // is a mutating/execute tool and stays exempt (BST-1200 review
    // PRRT_kwDOONNKB86XkXqw) alongside the skill activation.
    const seeded = [
      { id: 'old-grep-a', size: 90_000, toolName: NATIVE_TOOL_ID.grepSearch },
      { id: 'old-grep-b', size: 90_000, toolName: NATIVE_TOOL_ID.grepSearch },
      { id: 'old-skill', size: 90_000, toolName: NATIVE_TOOL_ID.skill },
      { id: 'old-python-exempt', size: 90_000, toolName: NATIVE_TOOL_ID.runPython },
    ] as const;
    for (const [index, item] of seeded.entries()) {
      await insertMessage(
        db,
        {
          id: item.id,
          input: { fixture: item.id },
          result: { payload: `${item.id}:${'x'.repeat(item.size)}` },
          toolName: item.toolName,
        },
        new Date(Date.UTC(2026, 7, 8, 10, index)).toISOString()
      );
    }
    await db.query(
      `INSERT INTO mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId")
       VALUES ('user-current', 'thread-1', '{"format":2,"parts":[{"type":"text","text":"continue"}]}'::jsonb,
               'user', 'v2', '2026-08-08T11:00:00Z', 'resource-1')`
    );
    const currentTurn = [
      { id: 'current-turn-old', size: 90_000, toolName: NATIVE_TOOL_ID.runPython },
      {
        id: 'unrelated-later-message',
        size: 170_000,
        toolName: NATIVE_TOOL_ID.executeCommand,
      },
    ] as const;
    for (const [index, item] of currentTurn.entries()) {
      await insertMessage(
        db,
        {
          id: item.id,
          input: { fixture: item.id },
          result: { payload: `${item.id}:${'x'.repeat(item.size)}` },
          toolName: item.toolName,
        },
        new Date(Date.UTC(2026, 7, 8, 11, index + 1)).toISOString()
      );
    }
    const before = await db.query<{ content: string }>(
      `SELECT content::text AS content FROM mastra_messages WHERE role = 'assistant' ORDER BY id`
    );
    await recordSuccessfulToolProjection(
      {
        input: { content: 'trigger', path: 'src/unrelated.ts', root: 'root-a' },
        result: {
          bytesWritten: 7,
          created: true,
          path: 'src/unrelated.ts',
          rootId: 'root-a',
          rootName: 'workspace',
        },
        runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
        toolCallId: 'write-trigger',
        toolId: NATIVE_TOOL_ID.writeWorkspaceFile,
      },
      { getDatabase: databaseProvider, resetLoopGuards }
    );

    const overlays = await db.query<{ kind: string; toolCallId: string }>(
      `SELECT kind, tool_call_id AS "toolCallId" FROM brainstrike_assistant_tool_projection_rewrites ORDER BY tool_call_id`
    );
    expect(overlays.rows).toEqual([
      { kind: 'prune', toolCallId: 'old-grep-a' },
      { kind: 'prune', toolCallId: 'old-grep-b' },
    ]);
    expect(
      (
        await db.query<{ content: string }>(
          `SELECT content::text AS content FROM mastra_messages WHERE role = 'assistant' ORDER BY id`
        )
      ).rows
    ).toEqual(before.rows);

    const calls = [...seeded, ...currentTurn].map((item) => ({
      id: item.id,
      output: `${item.id}:original`,
      toolName: item.toolName,
    }));
    const lookup = createToolProjectionRewriteLookup(databaseProvider);
    const replay = JSON.stringify(await replayWithRewrites(lookup, calls));
    expect(replay).toContain('tool=brainstrike.grepSearch');
    expect(replay).toContain('old-skill:original');
    // runPython stays exempt as a mutating/execute tool even though old.
    expect(replay).toContain('old-python-exempt:original');
    expect(replay).toContain('current-turn-old:original');
    expect(replay).toContain('unrelated-later-message:original');
    expect(replay).not.toContain('old-grep-a:original');

    await db.query(
      `INSERT INTO brainstrike_assistant_message_tombstones (message_id, thread_id, rewind_id)
       VALUES ('message-unrelated-later-message', 'thread-1', 'rewind-unrelated')`
    );
    expect(JSON.stringify(await replayWithRewrites(lookup, calls))).not.toContain(
      'old-grep-a:original'
    );
    await recordSuccessfulToolProjection(
      {
        input: { content: 'trigger', path: 'src/unrelated.ts', root: 'root-a' },
        result: {
          bytesWritten: 7,
          created: true,
          path: 'src/unrelated.ts',
          rootId: 'root-a',
          rootName: 'workspace',
        },
        runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
        toolCallId: 'write-trigger-2',
        toolId: NATIVE_TOOL_ID.writeWorkspaceFile,
      },
      { getDatabase: databaseProvider, resetLoopGuards }
    );
    expect(
      (await db.query('SELECT * FROM brainstrike_assistant_tool_projection_rewrites')).rows
    ).toHaveLength(2);
    expect(resetLoopGuards).toHaveBeenCalledOnce();
  });
});
