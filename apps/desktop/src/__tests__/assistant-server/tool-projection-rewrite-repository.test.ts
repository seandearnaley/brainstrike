import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { logger } = vi.hoisted(() => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: vi.fn(() => logger),
}));

vi.mock('../../assistant-server/read-workspace-file-model-projection', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../assistant-server/read-workspace-file-model-projection')
    >();
  return {
    ...actual,
    projectReadWorkspaceFileModelOutput: vi.fn(actual.projectReadWorkspaceFileModelOutput),
  };
});

import { projectReadWorkspaceFileModelOutput } from '../../assistant-server/read-workspace-file-model-projection';
import {
  applyToolProjectionRewriteRecording,
  recordSuccessfulToolProjection,
} from '../../assistant-server/tool-projection-rewrite-repository';

function persistedInvocation(args: {
  id: string;
  input?: Record<string, unknown>;
  result: unknown;
  toolName?: string;
}): unknown {
  return {
    toolInvocation: {
      args: args.input ?? {},
      result: args.result,
      toolCallId: args.id,
      toolName: (args.toolName ?? NATIVE_TOOL_ID.readWorkspaceFile).replace('.', '_'),
    },
    type: 'tool-invocation',
  };
}

function readResult(content: string, overrides: Record<string, unknown> = {}) {
  return {
    content,
    endLine: 100,
    nextCursor: null,
    omittedChars: 0,
    path: 'src/a.ts',
    rootId: 'root-a',
    rootName: 'workspace',
    size: content.length,
    startLine: 1,
    totalLines: 100,
    truncated: false,
    ...overrides,
  };
}

function fakeDatabase(parts: readonly unknown[]) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM mastra_messages')) {
        return { rows: [{ content: parts }] };
      }
      return { rows: [] };
    }),
    transaction: vi.fn(
      async (callback) =>
        await callback({ query: vi.fn(async () => ({ rows: [{ toolCallId: 'read-old' }] })) })
    ),
  };
}

describe('tool projection rewrite recording', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an already-successful tool result when projection bookkeeping throws', async () => {
    const successfulResult = readResult('served content');
    const execute = vi.fn(async () => successfulResult);
    const tools = {
      [NATIVE_TOOL_ID.readWorkspaceFile]: { execute },
    };
    const decorated = applyToolProjectionRewriteRecording(tools as never, {
      memory: { resourceId: 'resource-1', threadId: 'thread-1' },
      toolProjectionRewriteLookup: { listActiveRewrites: async () => new Map() },
    });
    const decoratedRead = decorated[NATIVE_TOOL_ID.readWorkspaceFile] as unknown as {
      execute: (input: unknown, context?: unknown) => Promise<unknown>;
    };

    await expect(
      decoratedRead.execute(
        { endLine: 100, path: 'src/a.ts', root: 'root-a', startLine: 1 },
        undefined
      )
    ).resolves.toBe(successfulResult);
    expect(execute).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('builds a winning read rewrite candidate only once', async () => {
    const parts = Array.from({ length: 14 }, (_, index) =>
      persistedInvocation({ id: `read-old-${index}`, result: readResult('x'.repeat(5000)) })
    );
    const database = fakeDatabase(parts);

    await recordSuccessfulToolProjection(
      {
        input: { endLine: 100, path: 'src/a.ts', root: 'root-a', startLine: 1 },
        result: readResult('fresh'),
        runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
        toolCallId: 'read-new',
        toolId: NATIVE_TOOL_ID.readWorkspaceFile,
      },
      { getDatabase: async () => database as never, resetLoopGuards: vi.fn() }
    );

    expect(projectReadWorkspaceFileModelOutput).toHaveBeenCalledTimes(14);
  });

  it('warns once per malformed persisted read invocation during a scan', async () => {
    const database = fakeDatabase([
      persistedInvocation({ id: 'read-malformed', result: { content: 'missing identity' } }),
      persistedInvocation({
        id: 'read-later-1',
        result: readResult('one', { path: 'src/one.ts' }),
      }),
      persistedInvocation({
        id: 'read-later-2',
        result: readResult('two', { path: 'src/two.ts' }),
      }),
      persistedInvocation({
        id: 'read-later-3',
        result: readResult('three', { path: 'src/three.ts' }),
      }),
    ]);

    await recordSuccessfulToolProjection(
      {
        input: { content: 'unrelated', path: 'src/four.ts', root: 'root-a' },
        result: {
          bytesWritten: 9,
          created: false,
          path: 'src/four.ts',
          rootId: 'root-a',
          rootName: 'workspace',
        },
        runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
        toolCallId: 'write-later-4',
        toolId: NATIVE_TOOL_ID.writeWorkspaceFile,
      },
      { getDatabase: async () => database as never, resetLoopGuards: vi.fn() }
    );

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping malformed persisted read result during supersession detection',
      expect.objectContaining({ toolCallId: 'read-malformed' })
    );
  });
});
