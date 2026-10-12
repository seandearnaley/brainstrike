import { APPROX_CHARS_PER_TOKEN, decodedTextModelOutputChars } from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import {
  buildRecencyPruneMarker,
  selectRecencyPruneCandidates,
  TOOL_PROJECTION_PRUNE_MIN_RECLAIM_TOKENS,
  TOOL_PROJECTION_PRUNE_PROTECT_WINDOW_TOKENS,
} from '../src/native-tools/index.js';

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
