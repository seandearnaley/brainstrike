// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ChatModelAdapter } from '@assistant-ui/react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { AnsweredApprovalsProvider } from '../answered-approvals-index';
import { ApprovalSubmissionProvider } from '../approval-submission-provider';
import { AssistantDataRendererRegistration } from '../assistant-data-renderer-registration';
import { Harness, runEventPart } from './assistant-activity-timeline-fixtures';

const neverRun = {
  async run() {
    throw new Error('Hydration must not invoke a model.');
  },
};

const completedReasoning = { text: 'Reasoned.', type: 'reasoning' as const };

function tool(toolCallId: string, extra: Record<string, unknown> = {}) {
  return {
    args: {},
    argsText: '{}',
    result: { ok: true },
    toolCallId,
    toolName: `tool_${toolCallId}`,
    type: 'tool-call' as const,
    ...extra,
  };
}

/**
 * A deferred promise the test controls, plus the `resolve` to release it.
 * Each running-reasoning test below builds its own single-yield
 * `ChatModelAdapter` around one of these — same shape as
 * `assistant-reasoning-disclosure.behavior.test.tsx`'s streaming fixture,
 * trimmed to a single held chunk. Assertions run while the run is still
 * "running"; the caller MUST release the deferred (inside `act`) once done,
 * or the generator — and the test — hangs.
 */
function createDeferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release: () => {
      release?.();
    },
  };
}

describe('AssistantActivityParts (hydrated messages)', () => {
  it('renders completed reasoning with a static reasoning mark', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[{ content: [completedReasoning], role: 'assistant' }]}
      />
    );
    // Since BST-1681 the reasoning disclosure is a step row: the tense lives
    // in the row's verb slot and the indicator span carries the static mark.
    const row = await screen.findByTestId('local-chain-of-thought');
    expect(within(row).getByText('Thought', { exact: true })).toBeInTheDocument();
    expect(within(row).getByTestId('assistant-reasoning-indicator')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-reasoning-static-mark')).toHaveClass(
      'bs-thinking-mark-static'
    );
    expect(screen.queryByTestId('assistant-thinking-indicator')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assistant-reasoning-live-mark')).not.toBeInTheDocument();
  });

  it('summarizes the tool calls within one activity group', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[{ content: [tool('a'), tool('b'), tool('c')], role: 'assistant' }]}
      />
    );
    expect(await screen.findByTestId('assistant-activity-group')).toBeInTheDocument();
    expect(screen.getByText(/3 steps/)).toBeInTheDocument();
    expect(screen.getAllByTestId('tool-fallback')).toHaveLength(3);
  });

  it('retains the activity wrapper for a completed single tool call', async () => {
    render(
      <Harness adapter={neverRun} initialMessages={[{ content: [tool('a')], role: 'assistant' }]} />
    );
    expect(await screen.findByTestId('assistant-activity-group')).toBeInTheDocument();
    expect(screen.getByTestId('tool-fallback')).toBeInTheDocument();
  });

  it('keeps each reasoning block collapsed by default and hides the reasoning text', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[{ content: [completedReasoning, tool('a')], role: 'assistant' }]}
      />
    );
    const fold = await screen.findByTestId('local-chain-of-thought');
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Reasoned.')).not.toBeInTheDocument();
  });

  it('renders text parts outside any activity group', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[
          { content: [tool('a'), { text: 'Answer.', type: 'text' }], role: 'assistant' },
        ]}
      />
    );
    // AssistantMessageText lazy-loads its markdown renderer via a dynamic
    // import (see assistant-message-text.tsx); the real panel preloads it on
    // mount, but this isolated Harness does not, so the text part isn't
    // guaranteed to be in the DOM the instant the group is. `findByText`
    // waits for the async import to resolve, matching the pattern already
    // used in assistant-activity-timeline.behavior.test.tsx. Only once the
    // text node has settled can the group-exclusion check be meaningful.
    const text = await screen.findByText('Answer.');
    const group = screen.getByTestId('assistant-activity-group');
    expect(group.contains(text)).toBe(false);
  });

  // The WRAPPER half of the part-level `isError` forward (Task 6 review,
  // Important 2). `subagent-execution-card.test.tsx` pins the presentational
  // card's reading of the flag by handing it the prop directly; nothing pinned
  // that `SubagentExecutionCardConnected` actually FORWARDS `props.isError`
  // from the tool part — the conditional spread that does it could be deleted
  // and every card-level test would stay green. This case runs the real
  // registered component through the harness: a settled delegation whose
  // status is `complete` and whose result never states a failure, flagged
  // errored by the runtime alone.
  it('forwards a delegation part’s isError flag through the registered card: the row reads Explorer failed', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[
          {
            content: [
              {
                args: {},
                argsText: '{}',
                isError: true,
                result: { subAgentToolResults: [], text: 'Found it.' },
                toolCallId: 'delegate-errored',
                toolName: 'agent-explore',
                type: 'tool-call' as const,
              },
            ],
            role: 'assistant',
          },
        ]}
      />
    );
    const group = await screen.findByTestId('assistant-activity-group');
    // A done group auto-collapses, so the delegation row is hidden until the
    // user opens it — the flag's effect is on the ROW, not on the headline.
    await user.click(screen.getByTestId('assistant-activity-summary'));
    expect(within(group).getByText('Explorer failed')).toBeInTheDocument();
    expect(within(group).queryByText('Explorer finished')).not.toBeInTheDocument();
    expect(within(group).getByRole('img', { name: 'Failed' })).toBeInTheDocument();
  });
});

describe('AssistantActivityParts (running reasoning, real runtime)', () => {
  it('shows the animated thinking indicator while reasoning streams', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred();
    const adapter: ChatModelAdapter = {
      async *run() {
        yield { content: [{ text: 'Thinking hard.', type: 'reasoning' as const }] };
        await deferred.promise;
      },
    };

    try {
      render(<Harness adapter={adapter} />);
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Investigate.');
      await user.click(screen.getByRole('button', { name: 'Send' }));

      // The activity group starts collapsed even while active (BST-1677 wave
      // 3): expand it before reaching a control/text inside its body.
      await user.click(await screen.findByRole('button', { name: 'Expand activity' }));

      const fold = (await screen.findAllByTestId('local-chain-of-thought'))[0];
      if (!fold) {
        throw new Error('Expected a reasoning toggle.');
      }
      // BST-1681: the row's glyph slot holds the live mark itself (the verb
      // slot next to it already reads "Thinking"), so the streaming row
      // carries exactly one `[data-live="true"]` element.
      const mark = within(fold).getByTestId('assistant-reasoning-live-mark');
      expect(mark).toHaveAttribute('data-tone', 'greyscale');
      expect(mark).toHaveAttribute('data-live', 'true');
      expect(fold.querySelectorAll('[data-live="true"]')).toHaveLength(1);
      expect(within(fold).getByText('Thinking', { exact: true })).toBeInTheDocument();
      expect(within(fold).queryByTestId('assistant-reasoning-static-mark')).toBeNull();
      expect(fold).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('Thinking hard.')).toBeVisible();
      // The group HEADER cycles too (BST-1677 wave 3): a running reasoning
      // part with no active tool yet reads "Thinking", not "Working".
      expect(screen.getByTestId('assistant-activity-working')).toHaveTextContent('Thinking');
    } finally {
      await act(async () => {
        deferred.release();
        await deferred.promise;
      });
    }
  }, 20_000);

  it('keeps completed reasoning static while a tool call in the same group is running', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred();
    const adapter: ChatModelAdapter = {
      async *run() {
        yield {
          content: [
            { text: 'Reasoned.', type: 'reasoning' as const },
            {
              args: {},
              argsText: '{}',
              toolCallId: 'a',
              toolName: 'tool_a',
              type: 'tool-call' as const,
            },
          ],
        };
        await deferred.promise;
      },
    };

    try {
      render(<Harness adapter={adapter} />);
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Investigate.');
      await user.click(screen.getByRole('button', { name: 'Send' }));

      // The activity group starts collapsed even while active (BST-1677 wave
      // 3): expand it before reaching a control/text inside its body.
      await user.click(await screen.findByRole('button', { name: 'Expand activity' }));

      const fold = (await screen.findAllByTestId('local-chain-of-thought'))[0];
      if (!fold) {
        throw new Error('Expected a reasoning toggle.');
      }
      const staticMark = within(fold).getByTestId('assistant-reasoning-static-mark');
      expect(staticMark).toHaveClass('bs-thinking-mark-static');
      expect(staticMark).toHaveAttribute('data-live', 'false');
      // Scoped to the fold: a running tool card legitimately renders its own
      // live mark inside the group body, so asserting on `screen` directly
      // here would be a false negative for this check. (The message-level
      // `indicator` slot is suppressed once an activity part exists — pinned
      // below.)
      expect(within(fold).queryByTestId('assistant-reasoning-live-mark')).toBeNull();
      expect(fold.querySelectorAll('[data-live="true"]')).toHaveLength(0);
      expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-active', 'true');
      // The reasoning part already settled once the tool call started
      // streaming in the same chunk, so the header names the running TOOL
      // instead of thinking (BST-1677 wave 3, BST-1679 verbs). `tool_a` is
      // not a native id and carries no dot, so it reads honestly as "Using".
      expect(screen.getByTestId('assistant-activity-working')).toHaveTextContent('Using tool_a');
    } finally {
      await act(async () => {
        deferred.release();
        await deferred.promise;
      });
    }
  }, 20_000);

  it('shows the pre-first-token thinking indicator until the first part arrives, then hides it', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred();
    const adapter: ChatModelAdapter = {
      async *run() {
        await deferred.promise;
        yield { content: [{ text: 'Hello.', type: 'text' as const }] };
      },
    };

    try {
      render(<Harness adapter={adapter} />);
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Hi.');
      await user.click(screen.getByRole('button', { name: 'Send' }));

      const indicator = await screen.findByTestId('assistant-thinking-indicator');
      expect(indicator).toBeInTheDocument();
      expect(screen.getByTestId('assistant-thinking-mark')).toHaveAttribute('data-live', 'true');

      await act(async () => {
        deferred.release();
        await deferred.promise;
      });

      await screen.findByText('Hello.');
      await waitFor(() =>
        expect(screen.queryByTestId('assistant-thinking-indicator')).not.toBeInTheDocument()
      );
    } finally {
      await act(async () => {
        deferred.release();
      });
    }
  }, 20_000);

  it('shows the thinking indicator for a running message whose only part is a run.started data part', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred();
    const adapter: ChatModelAdapter = {
      async *run() {
        yield {
          content: [
            runEventPart({
              id: 'e-run',
              kind: 'run.started',
              status: 'running',
              timestamp: '2026-09-05T10:00:00.000Z',
            }),
          ],
        };
        await deferred.promise;
      },
    };

    try {
      render(<Harness adapter={adapter} />);
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Investigate.');
      await user.click(screen.getByRole('button', { name: 'Send' }));

      expect(await screen.findByTestId('assistant-thinking-indicator')).toBeInTheDocument();
    } finally {
      await act(async () => {
        deferred.release();
        await deferred.promise;
      });
    }
  }, 20_000);

  it('renders no message-level thinking indicator while the trailing group holds activity: its header is the live status', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred();
    const adapter: ChatModelAdapter = {
      async *run() {
        yield {
          content: [
            runEventPart({
              id: 'e-run',
              kind: 'run.started',
              status: 'running',
              timestamp: '2026-09-05T10:00:00.000Z',
            }),
            runEventPart({
              id: 'e-tool',
              kind: 'tool.started',
              status: 'running',
              timestamp: '2026-09-05T10:00:01.000Z',
              toolCallId: 'call-1',
            }),
            {
              args: { pattern: 'x' },
              argsText: '{"pattern":"x"}',
              toolCallId: 'call-1',
              toolName: 'brainstrike.grepSearch',
              type: 'tool-call' as const,
            },
          ],
        };
        await deferred.promise;
      },
    };

    try {
      render(<Harness adapter={adapter} />);
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Investigate.');
      await user.click(screen.getByRole('button', { name: 'Send' }));

      const group = await screen.findByTestId('assistant-activity-group');
      expect(group).toHaveAttribute('data-state', 'running');
      expect(within(group).getByTestId('assistant-activity-working')).toHaveTextContent(
        'Searching x'
      );
      // The library still emits its `indicator` slot here (last part is a tool
      // call, not text/reasoning); the renderer must drop it so a collapsed
      // group never shows a second "Thinking" row beneath its own cycler
      // (CDT pass 4 defect). The running card's own indicator lives INSIDE the
      // group body and is not what this pins.
      expect(indicatorsOutsideGroups()).toHaveLength(0);
    } finally {
      await act(async () => {
        deferred.release();
        await deferred.promise;
      });
    }
  }, 20_000);

  it('keeps the message-level indicator when text ended the group and only a transparent data part trails', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred();
    const adapter: ChatModelAdapter = {
      async *run() {
        yield {
          content: [
            { text: 'Looking.', type: 'reasoning' as const },
            {
              args: { path: 'a.ts' },
              argsText: '{"path":"a.ts"}',
              result: { ok: true },
              toolCallId: 'call-1',
              toolName: 'brainstrike.readWorkspaceFile',
              type: 'tool-call' as const,
            },
            runEventPart({
              id: 'e-done',
              kind: 'tool.completed',
              status: 'completed',
              timestamp: '2026-09-05T10:00:01.000Z',
              toolCallId: 'call-1',
            }),
            { text: 'Now the second step.', type: 'text' as const },
            runEventPart({
              id: 'e-next',
              kind: 'tool.started',
              status: 'running',
              timestamp: '2026-09-05T10:00:02.000Z',
              toolCallId: 'call-2',
            }),
          ],
        };
        await deferred.promise;
      },
    };

    try {
      render(<Harness adapter={adapter} />);
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Investigate.');
      await user.click(screen.getByRole('button', { name: 'Send' }));

      await screen.findByText('Now the second step.');
      // Text split the activity: the first group is no longer trailing and
      // reads as settled, and the trailing `tool.started` forms a bare
      // data-only group that renders nothing. The message-level indicator is
      // therefore the turn's ONLY live affordance until the next tool-call
      // part lands — suppressing it on "any activity part anywhere" darkened
      // this window (wave-3 review finding).
      expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-state', 'done');
      await waitFor(() => expect(indicatorsOutsideGroups()).toHaveLength(1));
      expect(screen.getByTestId('assistant-thinking-mark')).toHaveAttribute('data-live', 'true');
    } finally {
      await act(async () => {
        deferred.release();
        await deferred.promise;
      });
    }
  }, 20_000);

  // BST-1679 task 6: the built-in Explorer persona's delegation tool is
  // `agent-explore` (`SUBAGENT_DELEGATION_TOOL_PREFIX` + persona id `explore`,
  // see activity-verbs.ts / personas.ts) — its verb reads "Delegating to
  // Explorer" while the call is open and "Delegated to Explorer" once it
  // resolves. No primary-arg key on an empty `args` object, so the live
  // label is the bare verb with no trailing target.
  it('reads Delegating to Explorer while a delegation runs, then Delegated once it resolves', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred();
    const adapter: ChatModelAdapter = {
      async *run() {
        yield {
          content: [
            {
              args: {},
              argsText: '{}',
              toolCallId: 'delegate-1',
              toolName: 'agent-explore',
              type: 'tool-call' as const,
            },
          ],
        };
        await deferred.promise;
        yield {
          content: [
            {
              args: {},
              argsText: '{}',
              result: { subAgentToolResults: [], text: 'Found it.' },
              toolCallId: 'delegate-1',
              toolName: 'agent-explore',
              type: 'tool-call' as const,
            },
          ],
        };
      },
    };

    try {
      render(<Harness adapter={adapter} />);
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Explore.');
      await user.click(screen.getByRole('button', { name: 'Send' }));

      const group = await screen.findByTestId('assistant-activity-group');
      expect(within(group).getByTestId('assistant-activity-working')).toHaveTextContent(
        'Delegating to Explorer'
      );
      expect(group).toHaveAttribute('data-state', 'running');

      await act(async () => {
        deferred.release();
        await deferred.promise;
      });

      await waitFor(() => expect(group).toHaveAttribute('data-state', 'done'));
      expect(
        within(group).getByText('Delegated to Explorer', { selector: '.bs-activity-summary-label' })
      ).toBeInTheDocument();
    } finally {
      // `release` and awaiting an already-resolved `promise` are both
      // idempotent — this mirrors the other tests' unconditional
      // release-in-finally even though this test's try body already
      // released once to unblock the second (resolved) yield.
      await act(async () => {
        deferred.release();
        await deferred.promise;
      });
    }
  }, 20_000);

  // BST-1679 task 6: a call paused at its approval gate carries
  // `requires-action` on the message (and therefore on its own resultless
  // tool-call part — see `toMessagePartStatus`), never `running` — this is a
  // genuine LIVE in-session pause, not something reload/hydration produces
  // (that case settles to `complete`; see assistant-hydration-liveness.test.tsx's
  // "abandoned approval" case), so this case belongs with the other live
  // states rather than the hydrated-messages describe above.
  // `initialMessages` seeds `reason: 'interrupt'`, but `Harness`'s
  // `useLocalRuntime` imports it through `@assistant-ui/core`'s
  // `withLocalPauseReason` (`local-thread-runtime-core.ts`), which rewrites
  // any `requires-action`/`interrupt` message whose tool call carries no
  // `.interrupt`/`.approval` payload — nothing left to resume via
  // `resumeInterrupt` — to `reason: 'tool-calls'` (`type` stays
  // `requires-action`), since this fixture's `tool()` sets neither field. So
  // what this case actually exercises is the broad `requires-action` TYPE
  // path, not the `interrupt` reason specifically. `Harness`'s
  // `initialMessages` still seeds the in-session shape without needing a
  // live deferred adapter.
  it('reads Waiting for approval while a call is paused at its gate', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[
          {
            content: [
              tool('x', {
                args: { command: 'rm x' },
                argsText: '{"command":"rm x"}',
                result: undefined,
                toolName: 'brainstrike.executeCommand',
              }),
            ],
            role: 'assistant',
            status: { reason: 'interrupt', type: 'requires-action' },
          },
        ]}
      />
    );
    const group = await screen.findByTestId('assistant-activity-group');
    expect(within(group).getByTestId('assistant-activity-working')).toHaveTextContent(
      'Waiting for approval'
    );
    expect(group).toHaveAttribute('data-state', 'running');
    const liveElements = document.querySelectorAll('[data-live="true"]');
    expect(liveElements).toHaveLength(1);
    expect(liveElements[0]).toHaveAttribute('data-testid', 'assistant-activity-working-mark');
  });

  // The other half of the same pause, one level down (BST-1681 task 6): the
  // header names it, and the STEP ROW inside the group has to agree. The row
  // reads the ACTIVE tense with the glyph carrying the state (bot round 1,
  // Claude Important 3 — the done tense read "Ran rm x" of a command that has
  // not run, which is the one thing a step row must never assert), and it
  // stays static: the gate is on the USER, so nothing in the row may pulse.
  // The group's single live mark is the header's own, which is what makes the
  // one pulsing thing on screen the thing that is actually waiting.
  it('renders the gated call as a static Waiting for approval step row', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[
          {
            content: [
              tool('x', {
                args: { command: 'rm x' },
                argsText: '{"command":"rm x"}',
                result: undefined,
                toolName: 'brainstrike.executeCommand',
              }),
            ],
            role: 'assistant',
            status: { reason: 'interrupt', type: 'requires-action' },
          },
        ]}
      />
    );
    const group = await screen.findByTestId('assistant-activity-group');
    await user.click(within(group).getByRole('button', { name: 'Expand activity' }));

    const row = within(group).getByTestId('activity-step-row');
    expect(within(row).getByText('Running', { exact: true })).toBeInTheDocument();
    expect(within(row).queryByText('Ran', { exact: true })).toBeNull();
    expect(within(row).getByRole('img', { name: 'Waiting for approval' })).toBeInTheDocument();
    expect(row.querySelectorAll('[data-live="true"]')).toHaveLength(0);

    // The header still owns the pause, and owns the ONLY live mark in the
    // whole group — row included.
    expect(within(group).getByTestId('assistant-activity-working')).toHaveTextContent(
      'Waiting for approval'
    );
    const live = group.querySelectorAll('[data-live="true"]');
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveAttribute('data-testid', 'assistant-activity-working-mark');
  });

  // Same pause, one part later: the library's `GroupPart.status` mirrors the
  // group's LAST member, and a group-transparent run-event data part can be
  // that member — so the raw group status reads "complete" while the gated
  // call in the same group is still `requires-action`. Reading the clause off
  // the raw status darkened the whole approval wait in exactly the shape
  // #3061 finding 1 fixed for the headline; `isActivityActive` derives it
  // from the group's ACTIVITY parts instead.
  it('stays Waiting for approval when a transparent run-event trails the gated call', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[
          {
            content: [
              tool('x', {
                args: { command: 'rm x' },
                argsText: '{"command":"rm x"}',
                result: undefined,
                toolName: 'brainstrike.executeCommand',
              }),
              runEventPart({
                id: 'e-tool',
                kind: 'tool.started',
                status: 'running',
                timestamp: '2026-09-05T10:00:01.000Z',
                toolCallId: 'x',
              }),
            ],
            role: 'assistant',
            status: { reason: 'interrupt', type: 'requires-action' },
          },
        ]}
      />
    );
    const group = await screen.findByTestId('assistant-activity-group');
    expect(within(group).getByTestId('assistant-activity-working')).toHaveTextContent(
      'Waiting for approval'
    );
    expect(group).toHaveAttribute('data-state', 'running');
    expect(document.querySelectorAll('[data-live="true"]')).toHaveLength(1);
  });
});

function indicatorsOutsideGroups(): Element[] {
  return [...document.querySelectorAll('[data-testid="assistant-thinking-indicator"]')].filter(
    (element) => element.closest('[data-testid="assistant-activity-group"]') === null
  );
}

it('uses the approval card as the single pause surface, without a second waiting activity box', async () => {
  render(
    <Harness
      adapter={neverRun}
      initialMessages={[
        {
          content: [
            completedReasoning,
            tool('paused-call', { result: undefined }),
            runEventPart({
              id: 'approval-event',
              kind: 'tool.approval.requested',
              status: 'running',
              timestamp: '2026-09-27T20:21:00Z',
              toolCallId: 'paused-call',
            }),
            {
              data: {
                runId: 'run',
                toolCallId: 'paused-call',
                toolName: 'brainstrike.executeCommand',
              },
              name: 'brainstrike.tool-approval',
              type: 'data',
            },
          ],
          role: 'assistant',
          status: { reason: 'interrupt', type: 'requires-action' },
        },
      ]}
    >
      {(content) => (
        <ApprovalSubmissionProvider>
          <AnsweredApprovalsProvider>
            <AssistantDataRendererRegistration />
            {content}
          </AnsweredApprovalsProvider>
        </ApprovalSubmissionProvider>
      )}
    </Harness>
  );
  expect(
    await screen.findByRole('button', { name: 'Approve brainstrike.executeCommand' })
  ).toBeEnabled();
  expect(screen.queryByText('Approval requested')).not.toBeInTheDocument();
  expect(screen.queryByText('Waiting for approval')).not.toBeInTheDocument();
  expect(screen.queryByTestId('tool-fallback')).not.toBeInTheDocument();
  expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-state', 'done');
});

it('retains the foreground child card when its approval replaces the waiting wrapper', () => {
  render(
    <Harness
      adapter={neverRun}
      initialMessages={[
        {
          content: [
            tool('delegate', {
              args: { prompt: 'Inspect evidence.' },
              result: undefined,
              toolName: 'agent-explore',
            }),
            {
              data: {
                runId: 'root',
                toolCallId: 'delegate',
                toolName: 'brainstrike.readWorkspaceFile',
              },
              name: 'brainstrike.tool-approval',
              type: 'data',
            },
          ],
          role: 'assistant',
          status: { reason: 'interrupt', type: 'requires-action' },
        },
      ]}
    />
  );
  expect(screen.getByText('Delegating to Explorer')).toBeInTheDocument();
  expect(screen.getByText('Inspect evidence.')).toBeInTheDocument();
  expect(screen.queryByTestId('assistant-activity-group')).not.toBeInTheDocument();
  expect(screen.queryByText('Waiting for approval')).not.toBeInTheDocument();
});
