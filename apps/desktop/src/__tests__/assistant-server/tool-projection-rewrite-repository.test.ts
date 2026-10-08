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

vi.mock(
  '../../../../../packages/host-capabilities/src/native-tools/read-workspace-file-model-projection',
  async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('@brainstrike/host-capabilities/native-tools')>();
    return {
      ...actual,
      projectReadWorkspaceFileModelOutput: vi.fn(actual.projectReadWorkspaceFileModelOutput),
    };
  }
);

import {
  APPROX_CHARS_PER_TOKEN,
  CEILING_SCALED_TOOL_RESULT_BUDGET,
  decodedTextModelOutputChars,
} from '@brainstrike/agent';
import { projectReadWorkspaceFileModelOutput } from '@brainstrike/host-capabilities/native-tools';

// The UNMOCKED projector, for building fixtures: production persists the
// PROJECTED model output, so fixtures must too (review finding — a raw-JSON
// default would claim the model actually saw the raw JSON, and it never
// throws, so budget regressions would pass trivially). Using the actual
// avoids polluting the mocked projector's call counts.
const { projectReadWorkspaceFileModelOutput: actualProjectRead } = await vi.importActual<
  typeof import('@brainstrike/host-capabilities/native-tools')
>(
  '../../../../../packages/host-capabilities/src/native-tools/read-workspace-file-model-projection'
);

import {
  buildRecencyPruneMarker,
  selectRecencyPruneCandidates,
  TOOL_PROJECTION_PRUNE_MIN_RECLAIM_TOKENS,
  TOOL_PROJECTION_PRUNE_PROTECT_WINDOW_TOKENS,
} from '../../assistant-server/tool-projection-prune';
import {
  applyToolProjectionRewriteRecording,
  recordSuccessfulToolProjection,
  resetMalformedProjectionMemoForTests,
  runRecencyPruneScan,
  setMalformedWarnMemoCapForTests,
  toRecencyPruneInvocation,
} from '../../assistant-server/tool-projection-rewrite-repository';

function fixtureModelOutput(result: unknown): { type: 'text'; value: string } {
  try {
    // Mirror the runtime: project under the ceiling scaled budget (the
    // loop-guard budget large-context runs actually used).
    return {
      type: 'text',
      value: actualProjectRead(
        result,
        CEILING_SCALED_TOOL_RESULT_BUDGET.domainModelResultCharBudget
      ).value,
    };
  } catch {
    // Unprojectable fixture results (the deliberately-malformed ones) keep a
    // measurable stand-in; their tests never reach measurement.
    return { type: 'text', value: JSON.stringify(result) };
  }
}

function persistedInvocation(args: {
  id: string;
  input?: Record<string, unknown>;
  result: unknown;
  toolName?: string;
}): unknown {
  return {
    providerMetadata: {
      mastra: { modelOutput: fixtureModelOutput(args.result) },
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
    resetMalformedProjectionMemoForTests();
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

  it('measures winning read candidates from the persisted model output, never by re-projecting', async () => {
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

    // BST-1249: persisted invocations carry the exact model-facing projection;
    // re-projecting the raw result would re-apply the DEFAULT domain budget,
    // which is smaller than the loop-guard/scaled budget some runtimes used.
    expect(projectReadWorkspaceFileModelOutput).not.toHaveBeenCalled();
  });

  it('does not brand a large read as malformed when its projection exceeds the default budget (BST-1249)', async () => {
    // Reproduces the 2026-08 audit rows: content projecting to ~10k chars was
    // legitimately projected at runtime under a scaled budget (up to 12k), but
    // history re-projection under the 6k default threw RangeError and mislabeled
    // the record `tool_projection_rewrite_malformed_read_history` on every scan.
    const database = fakeDatabase([
      persistedInvocation({ id: 'read-large', result: readResult('x'.repeat(10_500)) }),
    ]);

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

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('re-projects a legacy row without persisted model output under the ceiling budget (BST-1249)', async () => {
    const legacy = persistedInvocation({
      id: 'read-legacy-large',
      result: readResult('x'.repeat(10_500)),
    }) as { providerMetadata?: unknown };
    legacy.providerMetadata = undefined;
    const database = fakeDatabase([legacy]);

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

    // 10.5k chars fits the 12k ceiling budget even though it exceeds the 6k
    // default: a legacy row projected under a scaled runtime budget must not
    // be branded malformed.
    expect(projectReadWorkspaceFileModelOutput).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
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

  it('warns once per malformed record across scans, not once per scan (BST-1248)', async () => {
    const database = fakeDatabase([
      persistedInvocation({ id: 'read-malformed-cross-scan', result: { content: 'no identity' } }),
    ]);
    const scan = (toolCallId: string) =>
      recordSuccessfulToolProjection(
        {
          input: { endLine: 100, path: 'src/other.ts', root: 'root-a', startLine: 1 },
          result: readResult('fresh', { path: 'src/other.ts' }),
          runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
          toolCallId,
          toolId: NATIVE_TOOL_ID.readWorkspaceFile,
        },
        { getDatabase: async () => database as never, resetLoopGuards: vi.fn() }
      );

    await scan('read-new-1');
    await scan('read-new-2');
    await scan('read-new-3');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping malformed persisted read result during supersession detection',
      expect.objectContaining({ toolCallId: 'read-malformed-cross-scan' })
    );
  });

  it('still warns for each distinct malformed record (BST-1248 memo must not over-suppress)', async () => {
    const database = fakeDatabase([
      persistedInvocation({ id: 'read-malformed-a', result: { content: 'missing identity' } }),
      persistedInvocation({ id: 'read-malformed-b', result: { content: 'also malformed' } }),
    ]);

    await recordSuccessfulToolProjection(
      {
        input: { endLine: 100, path: 'src/other.ts', root: 'root-a', startLine: 1 },
        result: readResult('fresh', { path: 'src/other.ts' }),
        runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
        toolCallId: 'read-new-1',
        toolId: NATIVE_TOOL_ID.readWorkspaceFile,
      },
      { getDatabase: async () => database as never, resetLoopGuards: vi.fn() }
    );

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping malformed persisted read result during supersession detection',
      expect.objectContaining({ toolCallId: 'read-malformed-a' })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping malformed persisted read result during supersession detection',
      expect.objectContaining({ toolCallId: 'read-malformed-b' })
    );
  });

  it('keeps a warn-memoized record acting as a superseder on later scans (warn-dedup only)', async () => {
    // A(1-10) is superseded ONLY by X(5-20); X parses fine for detection but
    // its stricter projection contract throws (missing content/size/...), so
    // X warns once via readCandidate when L(15-30) supersedes it. If the memo
    // gated the PARSE instead of just the warn, scan 2 would drop X.read and
    // A would silently lose its only superseder — a context-reclamation
    // regression, not log hygiene (review finding on BST-1248).
    const projectionOnlyMalformed = {
      endLine: 20,
      path: 'src/a.ts',
      rootId: 'root-a',
      rootName: 'workspace',
      startLine: 5,
      totalLines: 100,
    };
    const legacyX = persistedInvocation({ id: 'read-x', result: projectionOnlyMalformed }) as {
      providerMetadata?: unknown;
    };
    legacyX.providerMetadata = undefined;
    const database = fakeDatabase([
      persistedInvocation({
        id: 'read-a',
        result: readResult('early', { endLine: 10, startLine: 1 }),
      }),
      legacyX,
      persistedInvocation({
        id: 'read-l',
        result: readResult('late', { endLine: 30, startLine: 15 }),
      }),
    ]);
    const scan = (toolCallId: string) =>
      recordSuccessfulToolProjection(
        {
          input: { endLine: 100, path: 'src/other.ts', root: 'root-a', startLine: 1 },
          result: readResult('fresh', { path: 'src/other.ts' }),
          runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
          toolCallId,
          toolId: NATIVE_TOOL_ID.readWorkspaceFile,
        },
        { getDatabase: async () => database as never, resetLoopGuards: vi.fn() }
      );

    await scan('read-new-1');
    await scan('read-new-2');

    // Both scans must attempt candidates for A (superseded by X, measured
    // from its persisted model output — no re-projection) and X (a LEGACY
    // row superseded by L whose ceiling re-projection throws): one
    // re-projection call per scan. A parse-gating memo would drop X.read on
    // scan 2 and silently lose A's only superseder.
    expect(projectReadWorkspaceFileModelOutput).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping malformed persisted read result during supersession detection',
      expect.objectContaining({ toolCallId: 'read-x' })
    );
  });

  it('announces suppression once at the distinct-record ceiling instead of an eviction cliff', async () => {
    setMalformedWarnMemoCapForTests(2);
    const database = fakeDatabase([
      persistedInvocation({ id: 'bad-1', result: { content: 'no identity' } }),
      persistedInvocation({ id: 'bad-2', result: { content: 'no identity' } }),
      persistedInvocation({ id: 'bad-3', result: { content: 'no identity' } }),
    ]);
    const scan = (toolCallId: string) =>
      recordSuccessfulToolProjection(
        {
          input: { endLine: 100, path: 'src/other.ts', root: 'root-a', startLine: 1 },
          result: readResult('fresh', { path: 'src/other.ts' }),
          runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
          toolCallId,
          toolId: NATIVE_TOOL_ID.readWorkspaceFile,
        },
        { getDatabase: async () => database as never, resetLoopGuards: vi.fn() }
      );

    await scan('read-new-1');
    await scan('read-new-2');

    // Two first-encounter warns, one suppression announcement, then silence —
    // scan 2 must not re-warn (the eviction-cliff failure mode).
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      'Further malformed persisted tool record warnings are suppressed',
      expect.objectContaining({ distinctRecordCap: 2 })
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

  it('runs the extracted on-demand prune scan without a synthetic tool execution', async () => {
    const oldArgs = { path: 'src/old.ts' };
    const parts = [
      persistedInvocation({
        id: 'old-prunable',
        input: oldArgs,
        result: readResult('x'.repeat(minReclaimChars + 1000)),
      }),
      persistedInvocation({
        id: 'protected-tail',
        result: readResult('x'.repeat(protectWindowChars)),
      }),
    ];
    const database = fakeDatabase(parts);
    const resetLoopGuards = vi.fn();

    await expect(
      runRecencyPruneScan(
        {
          runtimeData: { memory: { resourceId: 'resource-1', threadId: 'thread-1' } },
          threadId: 'thread-1',
        },
        { getDatabase: async () => database as never, resetLoopGuards }
      )
    ).resolves.toEqual({ prunedCount: 1 });
    expect(resetLoopGuards).toHaveBeenCalledOnce();
  });

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

  it('never selects skill/skill_read but selects skill_search like other read-only tools; runSkillScript is exempt as a mutator', () => {
    const searchArgs = { pattern: 'compaction' };
    const oldProjectedChars = projectedCharsForSavings(
      NATIVE_TOOL_ID.skillSearch,
      searchArgs,
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
          args: searchArgs,
          id: 'skill-search',
          projectedChars: oldProjectedChars,
          toolName: NATIVE_TOOL_ID.skillSearch,
        }),
        pruneFixture({
          id: 'run-skill-script',
          projectedChars: oldProjectedChars,
          toolName: NATIVE_TOOL_ID.runSkillScript,
        }),
        pruneFixture({ id: 'protected-tail', projectedChars: protectWindowChars }),
      ],
    });

    expect(candidates.map((candidate) => candidate.toolCallId)).toEqual(['skill-search']);
  });

  it('exempts mutating and interactive tools even though their reclaim would clear the floor', () => {
    const mutatorArgs = { path: 'src/mutated.ts' };
    const oldProjectedChars = projectedCharsForSavings(
      NATIVE_TOOL_ID.writeWorkspaceFile,
      mutatorArgs,
      minReclaimChars
    );
    const mutatingToolIds = [
      NATIVE_TOOL_ID.writeWorkspaceFile,
      NATIVE_TOOL_ID.stringReplaceWorkspaceFile,
      NATIVE_TOOL_ID.deleteWorkspaceFile,
      NATIVE_TOOL_ID.executeCommand,
      NATIVE_TOOL_ID.runPython,
      NATIVE_TOOL_ID.askUser,
      NATIVE_TOOL_ID.manageCanvas,
      NATIVE_TOOL_ID.manageTaskList,
    ] as const;
    const candidates = selectRecencyPruneCandidates({
      currentTurnToolCallIds: new Set(),
      invocations: [
        ...mutatingToolIds.map((toolName, index) =>
          pruneFixture({
            args: mutatorArgs,
            id: `mutator-${index}`,
            projectedChars: oldProjectedChars,
            toolName,
          })
        ),
        pruneFixture({ id: 'protected-tail', projectedChars: protectWindowChars }),
      ],
    });

    expect(candidates).toEqual([]);
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

describe('decodedPersistedModelOutputChars', () => {
  const protectWindowChars = TOOL_PROJECTION_PRUNE_PROTECT_WINDOW_TOKENS * APPROX_CHARS_PER_TOKEN;
  const minReclaimChars = TOOL_PROJECTION_PRUNE_MIN_RECLAIM_TOKENS * APPROX_CHARS_PER_TOKEN;

  it('measures type:"json" model outputs via the serialized ruler instead of throwing', () => {
    // readToolOutputArtifact's buildModelPage() and artifact settlement's
    // createArtifactOutputs() both persist `{ type: 'json', value }` —
    // precisely the largest, most pruning-worthy results (BST-1200 review
    // PRRT_kwDOONNKB86XkXki). A json invocation must participate in the
    // normal protect-window/floor selection like any other candidate.
    const jsonValue = { page: 1, totalPages: 3, value: 'x'.repeat(200_000) };
    const jsonArgs = { artifactId: 'artifact-1' };
    const jsonInvocation = {
      args: jsonArgs,
      modelOutput: { type: 'json' as const, value: jsonValue },
      toolCallId: 'artifact-json',
      toolName: NATIVE_TOOL_ID.readToolOutputArtifact,
    };

    const candidates = selectRecencyPruneCandidates({
      currentTurnToolCallIds: new Set(),
      invocations: [
        jsonInvocation,
        {
          args: { path: 'src/protected.ts' },
          modelOutput: { type: 'text' as const, value: 'x'.repeat(protectWindowChars) },
          toolCallId: 'protected-tail',
          toolName: NATIVE_TOOL_ID.readWorkspaceFile,
        },
      ],
    });

    expect(candidates.map((candidate) => candidate.toolCallId)).toEqual(['artifact-json']);
    expect(candidates[0]?.reclaimableChars).toBeGreaterThanOrEqual(minReclaimChars);
  });

  it('still throws for a genuinely unknown model output shape', () => {
    expect(() =>
      selectRecencyPruneCandidates({
        currentTurnToolCallIds: new Set(),
        invocations: [
          {
            args: {},
            modelOutput: { type: 'binary', value: 'unsupported' },
            toolCallId: 'unknown-shape',
            toolName: NATIVE_TOOL_ID.readWorkspaceFile,
          },
        ],
      })
    ).toThrow(/text, content, or json shaped/);
  });
});

describe('toRecencyPruneInvocation', () => {
  it('skips a native invocation missing its persisted model projection instead of throwing', () => {
    // Pre-existing threads may have native invocations persisted before
    // `providerMetadata.mastra.modelOutput` existed. Every other consumer of
    // this field treats absence as normal (BST-1200 review
    // PRRT_kwDOONNKB86XkXki) — skipping the invocation must not abort the
    // whole recency-pruning pass for the thread.
    const result = toRecencyPruneInvocation({
      args: { path: 'src/legacy.ts' },
      modelOutput: undefined,
      result: { path: 'src/legacy.ts' },
      toolCallId: 'legacy-call',
      toolName: NATIVE_TOOL_ID.readWorkspaceFile,
    });

    expect(result).toBeUndefined();
  });

  it('skips a non-native tool name', () => {
    const result = toRecencyPruneInvocation({
      args: {},
      modelOutput: { type: 'text', value: 'mcp result' },
      result: {},
      toolCallId: 'mcp-call',
      toolName: 'some_mcp_server.tool',
    });

    expect(result).toBeUndefined();
  });

  it('returns the invocation when the native tool has a persisted model projection', () => {
    const result = toRecencyPruneInvocation({
      args: { path: 'src/present.ts' },
      modelOutput: { type: 'text', value: 'file contents' },
      result: { path: 'src/present.ts' },
      toolCallId: 'present-call',
      toolName: NATIVE_TOOL_ID.readWorkspaceFile,
    });

    expect(result).toEqual({
      args: { path: 'src/present.ts' },
      modelOutput: { type: 'text', value: 'file contents' },
      toolCallId: 'present-call',
      toolName: NATIVE_TOOL_ID.readWorkspaceFile,
    });
  });
});
