/**
 * What counts as a pause a root Stop may have cancelled (BST-1749, PR #3214
 * review item 1). The renderer remounts the thread when this says yes, and a
 * remount is destructive, so the answer must be NARROW: only a pause in the
 * turn being stopped, and only one no decision has settled for.
 */
import type { ThreadMessage } from '@assistant-ui/react';
import {
  TOOL_APPROVAL_ANSWERED_DATA_NAME,
  TOOL_APPROVAL_DATA_NAME,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-approval';
import {
  TOOL_SUSPEND_DATA_NAME,
  TOOL_SUSPEND_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-suspend';
import { describe, expect, it } from 'vitest';
import { hasUndecidedPauseNotice } from '../undecided-pause-notices';

const PAUSE = {
  args: { pattern: 'TODO' },
  delegation: {
    path: [
      {
        childRuntimeRunId: 'child-run-1',
        parentRuntimeRunId: 'root-run',
        parentToolCallId: 'delegate-1',
        personaId: 'explore',
      },
    ],
    toolCallId: 'leaf-1',
  },
  riskCategory: 'read',
  runId: 'root-run',
  toolCallId: 'delegate-1',
  toolName: 'brainstrike.grepSearch',
} as const;

const ANSWER = {
  decision: 'approve',
  delegation: PAUSE.delegation,
  reason: 'session-grant',
  runId: PAUSE.runId,
  toolCallId: PAUSE.toolCallId,
  toolName: PAUSE.toolName,
} as const;

function userMessage(id: string, custom: Record<string, unknown> = {}): ThreadMessage {
  return {
    content: [{ text: id, type: 'text' }],
    createdAt: new Date(0),
    id,
    metadata: { custom },
    role: 'user',
  } as unknown as ThreadMessage;
}

function assistantMessage(id: string, content: readonly unknown[]): ThreadMessage {
  return {
    content,
    createdAt: new Date(0),
    id,
    metadata: { custom: {} },
    role: 'assistant',
    status: { type: 'running' },
  } as unknown as ThreadMessage;
}

/** A root askUser/submitPlan pause: the suspend half of the same gate. */
const SUSPEND = {
  runId: 'root-run',
  toolCallId: 'ask-1',
  toolName: 'brainstrike.askUser',
} as const;

const pausePart = (data: unknown) => ({ data, name: TOOL_APPROVAL_DATA_NAME, type: 'data' });
const suspendPart = (data: unknown) => ({ data, name: TOOL_SUSPEND_DATA_NAME, type: 'data' });
const answerPart = (data: unknown) => ({
  data,
  name: TOOL_APPROVAL_ANSWERED_DATA_NAME,
  type: 'data',
});

describe('hasUndecidedPauseNotice', () => {
  it('reports a pause raised in the turn being stopped', () => {
    expect(
      hasUndecidedPauseNotice([userMessage('turn-1'), assistantMessage('a1', [pausePart(PAUSE)])])
    ).toBe(true);
  });

  it('ignores a pause the host already answered in this session', () => {
    expect(
      hasUndecidedPauseNotice([
        userMessage('turn-1'),
        assistantMessage('a1', [pausePart(PAUSE), answerPart(ANSWER)]),
      ])
    ).toBe(false);
  });

  it("ignores a pause the user's own appended decision answered", () => {
    expect(
      hasUndecidedPauseNotice([
        userMessage('turn-1'),
        assistantMessage('a1', [pausePart(PAUSE)]),
        userMessage('decision', {
          [TOOL_APPROVAL_RUN_CONFIG_KEY]: {
            action: 'approve',
            delegation: PAUSE.delegation,
            runId: PAUSE.runId,
            toolCallId: PAUSE.toolCallId,
            toolName: PAUSE.toolName,
          },
        }),
      ])
    ).toBe(false);
  });

  it('ignores a still-pending pause from an earlier turn this cancel never touched', () => {
    expect(
      hasUndecidedPauseNotice([
        userMessage('turn-1'),
        assistantMessage('a1', [pausePart(PAUSE)]),
        userMessage('turn-2'),
        assistantMessage('a2', [{ text: 'working', type: 'text' }]),
      ])
    ).toBe(false);
  });

  it('ignores a pause that already carries a durable decision state', () => {
    expect(
      hasUndecidedPauseNotice([
        userMessage('turn-1'),
        assistantMessage('a1', [
          pausePart({
            ...PAUSE,
            decisionState: 'cancelled',
            stale: false,
            suspendedAt: '2026-09-15T10:00:00.000Z',
          }),
        ]),
      ])
    ).toBe(false);
  });

  /**
   * The case the narrowing actually risks: one pause answered in-session and a
   * SECOND still waiting on the same turn. Reporting per-pause (not "did this
   * turn answer anything") is what keeps B's card from going stale.
   */
  it('reports a second pause the turn never answered', () => {
    // A DIFFERENT child's leaf: identity keys a delegated pause on its
    // delegation leaf, so reusing the first one's would be the same pause.
    const second = {
      ...PAUSE,
      delegation: {
        path: [
          {
            childRuntimeRunId: 'child-run-2',
            parentRuntimeRunId: 'root-run',
            parentToolCallId: 'delegate-2',
            personaId: 'explore',
          },
        ],
        toolCallId: 'leaf-2',
      },
      toolCallId: 'delegate-2',
    };
    expect(
      hasUndecidedPauseNotice([
        userMessage('turn-1'),
        assistantMessage('a1', [pausePart(PAUSE), answerPart(ANSWER), pausePart(second)]),
      ])
    ).toBe(true);
  });

  it('reports a suspend pause nothing resumed', () => {
    expect(
      hasUndecidedPauseNotice([
        userMessage('turn-1'),
        assistantMessage('a1', [suspendPart(SUSPEND)]),
      ])
    ).toBe(true);
  });

  /**
   * A resume echo is an ACTION message, so it never becomes the turn anchor —
   * which is what keeps its own suspend pause inside the scanned window and
   * makes this branch reachable at all.
   */
  it('ignores a suspend pause the user resumed in this session', () => {
    expect(
      hasUndecidedPauseNotice([
        userMessage('turn-1'),
        assistantMessage('a1', [suspendPart(SUSPEND)]),
        userMessage('resume', {
          [TOOL_SUSPEND_RUN_CONFIG_KEY]: {
            resumeData: { answer: 'go on' },
            runId: SUSPEND.runId,
            toolCallId: SUSPEND.toolCallId,
            toolName: SUSPEND.toolName,
          },
        }),
      ])
    ).toBe(false);
  });

  it.each(['cancelled', 'claimed', 'consumed', 'interrupted'] as const)(
    'treats the durable %s state as an answer',
    (decisionState) => {
      expect(
        hasUndecidedPauseNotice([
          userMessage('turn-1'),
          assistantMessage('a1', [
            pausePart({
              ...PAUSE,
              decisionState,
              stale: false,
              suspendedAt: '2026-09-15T10:00:00.000Z',
            }),
          ]),
        ])
      ).toBe(false);
    }
  );

  it('reports nothing for a thread that never paused', () => {
    expect(
      hasUndecidedPauseNotice([
        userMessage('turn-1'),
        assistantMessage('a1', [{ text: 'done', type: 'text' }]),
      ])
    ).toBe(false);
  });
});
