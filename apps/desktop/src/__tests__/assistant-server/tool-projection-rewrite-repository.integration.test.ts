import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { grepProjectionHeaderPrefix } from '../../assistant-server/grep-search-result-contract';
import { readProjectionHeaderPrefix } from '../../assistant-server/read-workspace-file-result-contract';
import {
  buildGrepSupersededMarker,
  recordSuccessfulToolProjection,
  TOOL_PROJECTION_REWRITE_BATCH_THRESHOLD_CHARS,
} from '../../assistant-server/tool-projection-rewrite-repository';

function invocation(args: {
  readonly id: string;
  readonly input: Record<string, unknown>;
  readonly result: unknown;
  readonly toolName: string;
}): string {
  return JSON.stringify({
    content: [
      {
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

function readResult(contentLength: number, endLine = 100) {
  return {
    approxOutputTokens: contentLength,
    content: 'x'.repeat(contentLength),
    endLine,
    nextCursor: null,
    omittedChars: 0,
    path: 'src/a.ts',
    rootName: 'workspace',
    size: contentLength,
    startLine: 1,
    tokenCount: null,
    totalLines: endLine,
    truncated: false,
  };
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
        superseded_by_tool_call_id text NOT NULL,
        marker_text text NOT NULL,
        original_chars integer NOT NULL CHECK (original_chars >= 0),
        created_at timestamptz NOT NULL DEFAULT NOW()
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

    await insertMessage(
      db,
      {
        id: 'call-large',
        input: { endLine: 100, path: 'src/a.ts', root: 'workspace', startLine: 1 },
        result: readResult(TOOL_PROJECTION_REWRITE_BATCH_THRESHOLD_CHARS + 1),
        toolName: NATIVE_TOOL_ID.readWorkspaceFile,
      },
      '2026-08-08T12:01:00Z'
    );
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
    expect(rows.rows).toHaveLength(2);
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
    await insertMessage(
      db,
      {
        id: 'read-before-edit',
        input: { endLine: 100, path: 'src/a.ts', root: 'workspace', startLine: 1 },
        result: readResult(TOOL_PROJECTION_REWRITE_BATCH_THRESHOLD_CHARS + 1),
        toolName: NATIVE_TOOL_ID.readWorkspaceFile,
      },
      '2026-08-08T12:00:00Z'
    );

    await recordSuccessfulToolProjection(
      {
        input: { content: 'replacement', path: 'src/a.ts', root: 'workspace' },
        result: {
          bytesWritten: 11,
          created: false,
          path: 'src/a.ts',
          rootName: 'workspace',
        },
        runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
        toolCallId: 'edit-new',
        toolId: NATIVE_TOOL_ID.writeWorkspaceFile,
      },
      { getDatabase: databaseProvider, resetLoopGuards }
    );

    const rows = await db.query<{ superseded_by_tool_call_id: string }>(
      'SELECT superseded_by_tool_call_id FROM brainstrike_assistant_tool_projection_rewrites'
    );
    expect(rows.rows).toEqual([{ superseded_by_tool_call_id: 'edit-new' }]);
    expect(resetLoopGuards).toHaveBeenCalledWith('thread-1');
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
});
