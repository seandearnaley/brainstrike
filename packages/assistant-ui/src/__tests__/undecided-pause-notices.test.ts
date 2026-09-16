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

/**
 * A second root suspend. Undelegated pauses key on `[runId, toolCallId]`, so a
 * different `toolCallId` is already a different pause (unlike the delegated
 * case below, which keys on its delegation leaf). Everything else MATCHES
 * `SUSPEND`, so the test that uses it is strictly about `toolCallId`: were the
 * key to accidentally take in `toolName` too, a differing one would keep the
 * two apart and hide it.
 */
const SECOND_SUSPEND = {
  runId: 'root-run',
  toolCallId: 'ask-2',
  toolName: SUSPEND.toolName,
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
   * PAIRED with the test below, because this one alone cannot tell its two
   * mechanisms apart: it reads false both when the resume arm settles the key
   * AND when the echo becomes the turn anchor, collapsing the window to the
   * echo so no pause is scanned at all. This half pins the resume arm — it is
   * the only test that fails when `readAppendedDecisionKey` stops keying a
   * resume marker. The half below pins the anchor.
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

  /**
   * The anchor half. The echo goes LAST with a second, unresumed suspend ahead
   * of it, so the answer is true only if the echo was skipped by the anchor and
   * the window still reaches a1/a2. Were the echo the anchor, the window would
   * be the echo alone, nothing would be scanned, and this would read false.
   */
  it('reports a second suspend the resume echo left undecided', () => {
    expect(
      hasUndecidedPauseNotice([
        userMessage('turn-1'),
        assistantMessage('a1', [suspendPart(SUSPEND)]),
        assistantMessage('a2', [suspendPart(SECOND_SUSPEND)]),
        userMessage('resume', {
          [TOOL_SUSPEND_RUN_CONFIG_KEY]: {
            resumeData: { answer: 'go on' },
            runId: SUSPEND.runId,
            toolCallId: SUSPEND.toolCallId,
            toolName: SUSPEND.toolName,
          },
        }),
      ])
    ).toBe(true);
  });

  /**
   * Every state `readRediscoveredPauseDisplay` can report, `invalid` included —
   * which is NOT a member of the durable union but the sentinel that reader
   * stamps when a decision exists and could not be read. It locks the card just
   * as the terminal states do, so the gate must count it as an answer; leaving
   * it out of this table let it be dropped from the decided set unnoticed.
   *
   * Each row feeds its state in DIRECTLY, so what this pins is the gate's
   * decided-set membership — not the reader's stamping. The test below covers
   * the sentinel's own path.
   */
  it.each(['cancelled', 'claimed', 'consumed', 'interrupted', 'invalid'] as const)(
    'treats the %s decision state as an answer',
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

  /**
   * The sentinel's OWN path, which the table above does not travel. The state
   * here is a real durable one and the payload is what is unreadable: no
   * delegation and no `continuationId`, so `hasValidDelegatedDecisionState`
   * rejects it and the reader stamps `invalid`. A decision exists and could not
   * be read, so the card stays locked and the Stop must not remount for it.
   */
  it('treats a decision state it cannot read as an answer', () => {
    const unreadable = {
      args: PAUSE.args,
      decisionState: 'cancelled',
      riskCategory: PAUSE.riskCategory,
      runId: PAUSE.runId,
      toolCallId: PAUSE.toolCallId,
      toolName: PAUSE.toolName,
    };
    expect(
      hasUndecidedPauseNotice([
        userMessage('turn-1'),
        assistantMessage('a1', [pausePart(unreadable)]),
      ])
    ).toBe(false);
  });

  it('reports nothing for a thread that never paused', () => {
    expect(
      hasUndecidedPauseNotice([
        userMessage('turn-1'),
        assistantMessage('a1', [{ text: 'done', type: 'text' }]),
      ])
    ).toBe(false);
  });
});
