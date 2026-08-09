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

import { APPROX_CHARS_PER_TOKEN, decodedTextModelOutputChars } from '@brainstrike/agent';
import { projectReadWorkspaceFileModelOutput } from '../../assistant-server/read-workspace-file-model-projection';
import {
  buildRecencyPruneMarker,
  selectRecencyPruneCandidates,
  TOOL_PROJECTION_PRUNE_MIN_RECLAIM_TOKENS,
  TOOL_PROJECTION_PRUNE_PROTECT_WINDOW_TOKENS,
} from '../../assistant-server/tool-projection-prune';
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
    providerMetadata: {
      mastra: { modelOutput: { type: 'text', value: JSON.stringify(args.result) } },
    },
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

interface PruneFixtureOptions {
  readonly args?: Record<string, unknown>;
  readonly id: string;
  readonly projectedChars: number;
  readonly toolName?: (typeof NATIVE_TOOL_ID)[keyof typeof NATIVE_TOOL_ID];
}

function pruneFixture(options: PruneFixtureOptions) {
  const valueChars = options.projectedChars - 26;
  if (valueChars < 0) {
    throw new RangeError('Prune fixture must leave room for the projection envelope.');
  }
  return {
    args: options.args ?? { path: `src/${options.id}.ts` },
    modelOutput: { type: 'text' as const, value: 'x'.repeat(valueChars) },
    toolCallId: options.id,
    toolName: options.toolName ?? NATIVE_TOOL_ID.readWorkspaceFile,
  };
}

function projectedCharsForSavings(
  toolName: (typeof NATIVE_TOOL_ID)[keyof typeof NATIVE_TOOL_ID],
  args: Record<string, unknown>,
  savingsChars: number
): number {
  return decodedTextModelOutputChars(buildRecencyPruneMarker(toolName, args)) + savingsChars;
}

describe('recency-window tool projection pruning selection', () => {
  const protectWindowChars = TOOL_PROJECTION_PRUNE_PROTECT_WINDOW_TOKENS * APPROX_CHARS_PER_TOKEN;
  const minReclaimChars = TOOL_PROJECTION_PRUNE_MIN_RECLAIM_TOKENS * APPROX_CHARS_PER_TOKEN;

  it('protects the newest window exactly and selects the first invocation just outside it', () => {
    const oldArgs = { path: 'src/old.ts' };
    const candidates = selectRecencyPruneCandidates({
      currentTurnToolCallIds: new Set(),
      invocations: [
        pruneFixture({
          args: oldArgs,
          id: 'just-outside',
          projectedChars: projectedCharsForSavings(
            NATIVE_TOOL_ID.readWorkspaceFile,
            oldArgs,
            minReclaimChars
          ),
        }),
        pruneFixture({ id: 'exactly-inside', projectedChars: protectWindowChars }),
      ],
    });

    expect(candidates.map((candidate) => candidate.toolCallId)).toEqual(['just-outside']);
  });

  it('writes nothing just under the reclaim floor and selects the batch at the floor', () => {
    const underArgs = { path: 'src/under.ts' };
    const atArgs = { path: 'src/at.ts' };
    const protectedTail = pruneFixture({
      id: 'protected-tail',
      projectedChars: protectWindowChars,
    });

    expect(
      selectRecencyPruneCandidates({
        currentTurnToolCallIds: new Set(),
        invocations: [
          pruneFixture({
            args: underArgs,
            id: 'under-floor',
            projectedChars: projectedCharsForSavings(
              NATIVE_TOOL_ID.readWorkspaceFile,
              underArgs,
              minReclaimChars - 1
            ),
          }),
          protectedTail,
        ],
      })
    ).toEqual([]);

    expect(
      selectRecencyPruneCandidates({
        currentTurnToolCallIds: new Set(),
        invocations: [
          pruneFixture({
            args: atArgs,
            id: 'at-floor',
            projectedChars: projectedCharsForSavings(
              NATIVE_TOOL_ID.readWorkspaceFile,
              atArgs,
              minReclaimChars
            ),
          }),
          protectedTail,
        ],
      }).map((candidate) => candidate.toolCallId)
    ).toEqual(['at-floor']);
  });

  it('never selects skill activation surfaces but still prunes runSkillScript output', () => {
    const runArgs = { script: 'build-index' };
    const oldProjectedChars = projectedCharsForSavings(
      NATIVE_TOOL_ID.runSkillScript,
      runArgs,
      minReclaimChars
    );
    const candidates = selectRecencyPruneCandidates({
      currentTurnToolCallIds: new Set(),
      invocations: [
        pruneFixture({
          id: 'skill',
          projectedChars: oldProjectedChars,
          toolName: NATIVE_TOOL_ID.skill,
        }),
        pruneFixture({
          id: 'skill-read',
          projectedChars: oldProjectedChars,
          toolName: NATIVE_TOOL_ID.skillRead,
        }),
        pruneFixture({
          id: 'skill-search',
          projectedChars: oldProjectedChars,
          toolName: NATIVE_TOOL_ID.skillSearch,
        }),
        pruneFixture({
          args: runArgs,
          id: 'run-skill-script',
          projectedChars: oldProjectedChars,
          toolName: NATIVE_TOOL_ID.runSkillScript,
        }),
        pruneFixture({ id: 'protected-tail', projectedChars: protectWindowChars }),
      ],
    });

    expect(candidates.map((candidate) => candidate.toolCallId)).toEqual(['run-skill-script']);
  });

  it('excludes current-turn invocations and earlier invocations referenced by the current turn', () => {
    const referencedArgs = { path: 'src/referenced.ts' };
    const eligibleArgs = { path: 'src/eligible.ts' };
    const projectedChars = projectedCharsForSavings(
      NATIVE_TOOL_ID.readWorkspaceFile,
      eligibleArgs,
      minReclaimChars
    );
    const candidates = selectRecencyPruneCandidates({
      currentTurnToolCallIds: new Set(['current-turn', 'referenced-by-current-turn']),
      invocations: [
        pruneFixture({
          args: referencedArgs,
          id: 'referenced-by-current-turn',
          projectedChars,
        }),
        pruneFixture({ args: eligibleArgs, id: 'eligible-old', projectedChars }),
        pruneFixture({ id: 'protected-tail', projectedChars: protectWindowChars }),
        pruneFixture({ id: 'current-turn', projectedChars }),
      ],
    });

    expect(candidates.map((candidate) => candidate.toolCallId)).toEqual(['eligible-old']);
  });

  it('counts repeated Mastra snapshot copies of one tool call only once', () => {
    const duplicateArgs = { path: 'src/duplicate.ts' };
    const halfFloorChars = Math.floor(minReclaimChars / 2);
    const duplicate = pruneFixture({
      args: duplicateArgs,
      id: 'duplicate-call',
      projectedChars: projectedCharsForSavings(
        NATIVE_TOOL_ID.readWorkspaceFile,
        duplicateArgs,
        halfFloorChars
      ),
    });

    expect(
      selectRecencyPruneCandidates({
        currentTurnToolCallIds: new Set(),
        invocations: [
          duplicate,
          duplicate,
          pruneFixture({ id: 'protected-tail', projectedChars: protectWindowChars }),
        ],
      })
    ).toEqual([]);
  });
});
