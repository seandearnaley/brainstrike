import type { HostToolInvocation } from '@brainstrike/agent-host';
import { describe, expect, it } from 'vitest';
import {
  buildRecencyPruneMarker,
  selectHostProjectionRewrites,
} from '../src/native-tools/index.js';

function invocation(
  toolCallId: string,
  toolName: string,
  modelOutput: unknown,
  args: unknown = { pattern: toolCallId }
): HostToolInvocation {
  return { args, modelOutput, toolCallId, toolName };
}

const text = (chars: number) => ({ type: 'text', value: 'x'.repeat(chars) });

describe('selectHostProjectionRewrites', () => {
  it('prunes old read-only native results past the protect window, as legacy recency pruning did', () => {
    const rewrites = selectHostProjectionRewrites({
      currentTurnToolCallIds: new Set(['current']),
      invocations: [
        // Provider-facing (sanitized) names resolve to the native catalog ID.
        invocation('old-grep', 'brainstrike_grepSearch', text(100_000)),
        // Mutating tools are never pruned.
        invocation('old-write', 'brainstrike_writeWorkspaceFile', text(100_000), { path: 'a' }),
        // A failed call has no successful projection to replace.
        invocation('failed-grep', 'brainstrike_grepSearch', { type: 'error-text', value: 'x' }),
        // A call whose input is not an object is not a native invocation.
        invocation('odd-grep', 'brainstrike_grepSearch', text(100_000), 'not-an-object'),
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
});
