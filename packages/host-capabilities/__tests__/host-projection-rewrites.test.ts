import type { HostToolInvocation } from '@brainstrike/agent-host';
import { describe, expect, it } from 'vitest';
import {
  buildReadSupersededMarker,
  buildRecencyPruneMarker,
  selectHostProjectionRewrites,
} from '../src/native-tools/index.js';

function invocation(
  toolCallId: string,
  toolName: string,
  modelOutput: unknown,
  committed: { readonly args?: unknown; readonly output?: unknown } = {}
): HostToolInvocation {
  return {
    args: Object.hasOwn(committed, 'args') ? committed.args : { pattern: toolCallId },
    modelOutput,
    output: committed.output,
    toolCallId,
    toolName,
  };
}

/** The raw committed read result the native read tool returns (its file identity and range). */
const readResult = {
  endLine: 2000,
  path: 'src/a.ts',
  rootName: 'repo',
  startLine: 1,
  totalLines: 2000,
};

const text = (chars: number) => ({ type: 'text', value: 'x'.repeat(chars) });

describe('selectHostProjectionRewrites', () => {
  it('prunes old read-only native results past the protect window, as legacy recency pruning did', () => {
    const rewrites = selectHostProjectionRewrites({
      currentTurnToolCallIds: new Set(['current']),
      invocations: [
        // Provider-facing (sanitized) names resolve to the native catalog ID.
        invocation('old-grep', 'brainstrike_grepSearch', text(100_000)),
        // Mutating tools are never pruned.
        invocation('old-write', 'brainstrike_writeWorkspaceFile', text(100_000), {
          args: { path: 'a' },
        }),
        // A failed call has no successful projection to replace.
        invocation('failed-grep', 'brainstrike_grepSearch', { type: 'error-text', value: 'x' }),
        // A call whose input is not an object is not a native invocation.
        invocation('odd-grep', 'brainstrike_grepSearch', text(100_000), { args: 'not-an-object' }),
        // The newest 40,000 estimated tokens stay whole.
        invocation('recent-grep', 'brainstrike_grepSearch', text(200_000)),
        invocation('current', 'brainstrike_grepSearch', text(10)),
      ],
    });
    expect(rewrites).toEqual([
      {
        kind: 'prune',
        markerText: buildRecencyPruneMarker('brainstrike.grepSearch', { pattern: 'old-grep' }),
        supersededByToolCallId: null,
        toolCallId: 'old-grep',
      },
    ]);
  });

  it('selects nothing below the legacy 20,000-token reclaim minimum', () => {
    expect(
      selectHostProjectionRewrites({
        currentTurnToolCallIds: new Set(),
        invocations: [
          invocation('old-grep', 'brainstrike_grepSearch', text(40_000)),
          invocation('recent-grep', 'brainstrike_grepSearch', text(200_000)),
        ],
      })
    ).toEqual([]);
  });

  it('supersedes a read the run later rewrote, past the legacy 64 KiB batch threshold', () => {
    const rewrites = selectHostProjectionRewrites({
      currentTurnToolCallIds: new Set(['write']),
      invocations: [
        invocation('read', 'brainstrike_readWorkspaceFile', text(70_000), {
          args: { path: 'src/a.ts' },
          output: readResult,
        }),
        invocation('write', 'brainstrike_writeWorkspaceFile', text(20), {
          args: { content: 'next', path: 'src/a.ts' },
          output: { path: 'src/a.ts', rootName: 'repo' },
        }),
      ],
    });
    expect(rewrites).toEqual([
      {
        kind: 'supersession',
        markerText: buildReadSupersededMarker(readResult, 'brainstrike.writeWorkspaceFile'),
        supersededByToolCallId: 'write',
        toolCallId: 'read',
      },
    ]);
  });

  it('leaves a superseded read below the batch threshold for a later batch', () => {
    expect(
      selectHostProjectionRewrites({
        currentTurnToolCallIds: new Set(),
        invocations: [
          invocation('read', 'brainstrike_readWorkspaceFile', text(10_000), {
            args: { path: 'src/a.ts' },
            output: readResult,
          }),
          invocation('reread', 'brainstrike_readWorkspaceFile', text(10_000), {
            args: { path: 'src/a.ts' },
            output: readResult,
          }),
        ],
      })
    ).toEqual([]);
  });
});
