// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ChatModelAdapter, ThreadAssistantMessagePart } from '@assistant-ui/react';
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  commentsTool,
  completedParts,
  completedPartsWithEvents,
  firstParts,
  Harness,
  runEventPart,
  secondReasoning,
  secondTools,
} from './assistant-activity-timeline-fixtures';

/** Hydration-only renders: reaching the model at all is the failure. */
const neverRunAdapter: ChatModelAdapter = {
  async run() {
    throw new Error('Hydration must not invoke a model.');
  },
};

/**
 * The resting headline span inside `ActivityTrace`. Scoped queries need it
 * because the row also carries an sr-only phase announcement ("Stopped",
 * "Failed", "Finished"), so a bare `getByText('Stopped')` now matches twice.
 */
const HEADLINE_SELECTOR = '.bs-activity-summary-label';

function deferred() {
  let release: () => void = () => {
    throw new Error('Deferred promise was not initialized.');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * Runs the harness with a single yield of `parts` that never settles (the
 * model's `run()` blocks on an internal deferred), expands the activity
 * group, and returns the step rows' `.bs-step-row-verb` nodes plus a
 * `release()` to let the run finish. The three "only the last running row
 * shimmers" cases (read/grep, delegation, task list) shared this exact setup
 * verbatim before BST-1685 — they now only supply `parts` and their expected
 * verb text/shimmer vectors.
 *
 * `release()` is returned rather than called here: the whole point of the
 * shimmer assertions is to read the DOM while the run is still pending, so
 * the caller must assert BEFORE releasing (matching the pre-extraction
 * ordering), then release in its own `finally`.
 */
async function renderRunningGroup(parts: readonly ThreadAssistantMessagePart[]): Promise<{
  release: () => Promise<void>;
  rows: readonly Element[];
  verbs: readonly (Element | null)[];
}> {
  const finish = deferred();
  const adapter: ChatModelAdapter = {
    async *run() {
      yield { content: parts };
      await finish.promise;
    },
  };
  // BST-1685 review round 2, Claude Minor 3: `deferred()` moved into this
  // helper, so a throw anywhere below it (most plausibly `findByRole`
  // timing out when the rendering regresses) must still release the
  // adapter generator before propagating — otherwise the caller's own
  // `try/finally` never starts, and the pending run leaks past this test
  // (act/unmount noise on top of the real assertion failure). Restores the
  // `try/finally` guarantee `deferred()` used to get for free by living
  // inside the test itself.
  try {
    const user = userEvent.setup();
    render(<Harness adapter={adapter} />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.click(await screen.findByRole('button', { name: 'Expand activity' }));
    const group = screen.getByTestId('assistant-activity-group');
    const rows = [
      ...group.querySelectorAll(
        '[data-testid="local-chain-of-thought"], [data-testid="activity-step-row"]'
      ),
    ];
    const verbs = rows.map((row) => row.querySelector('.bs-step-row-verb'));
    return {
      release: () =>
        act(async () => {
          finish.release();
        }),
      rows,
      verbs,
    };
  } catch (error) {
    finish.release();
    throw error;
  }
}

function expectChronologicalGroups() {
  const groups = screen.getAllByTestId('assistant-activity-group');
  expect(groups).toHaveLength(2);
  const first = groups[0];
  const second = groups[1];
  if (!(first && second)) {
    throw new Error('Expected two activity groups.');
  }
  const text = screen.getByText('I found the issue.');
  expect(first.contains(text)).toBe(false);
  expect(second.contains(text)).toBe(false);
  expect(Boolean(first.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
    true
  );
  expect(Boolean(text.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
    true
  );
  expect(first).toHaveAttribute('data-active', 'false');
  return { first, second };
}

describe('assistant activity chronology through the real runtime', () => {
  it.each([false, true])(
    'settles cancellation without showing success (tools: %s)',
    async (includeTools) => {
      const adapter: ChatModelAdapter = {
        async *run({ abortSignal }) {
          yield { content: [...firstParts, secondReasoning, ...(includeTools ? secondTools : [])] };
          await new Promise<void>((resolve) => {
            if (abortSignal.aborted) {
              resolve();
              return;
            }
            abortSignal.addEventListener('abort', () => resolve(), { once: true });
          });
        },
      };
      const user = userEvent.setup();
      render(<Harness adapter={adapter} />);
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Inspect this issue.');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByText('I found the issue.');
      const { first, second } = expectChronologicalGroups();
      expect(second).toHaveAttribute('data-active', 'true');
      await user.click(screen.getByRole('button', { name: 'Stop' }));
      await waitFor(() => expect(second).toHaveAttribute('data-active', 'false'));
      expect(first).toHaveAttribute('data-active', 'false');
      expect(first).toHaveTextContent('Called linear.get_issue');
      expect(first).not.toHaveTextContent('Stopped');
      expect(second).toHaveTextContent('Stopped');
      expect(second).not.toHaveTextContent('Worked');
      expect(screen.getAllByTestId('assistant-activity-group')[0]).toBe(first);
      expect(screen.getAllByTestId('assistant-activity-group')[1]).toBe(second);
    }
  );

  it('keeps later reasoning and parallel tools after text without reactivating or remounting earlier groups', async () => {
    const think = deferred();
    const call = deferred();
    const finish = deferred();
    const adapter: ChatModelAdapter = {
      async *run() {
        yield { content: firstParts };
        await think.promise;
        yield { content: [...firstParts, secondReasoning] };
        await call.promise;
        yield { content: [...firstParts, secondReasoning, ...secondTools] };
        await finish.promise;
        yield { content: completedParts };
      },
    };
    const user = userEvent.setup();
    render(<Harness adapter={adapter} />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Inspect this issue.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('I found the issue.');
    try {
      await act(async () => {
        think.release();
      });
      await waitFor(() =>
        expect(screen.getAllByTestId('assistant-activity-group')).toHaveLength(2)
      );
      const { first, second } = expectChronologicalGroups();
      expect(second).toHaveAttribute('data-active', 'true');
      await user.click(within(first).getByRole('button', { name: 'Expand activity' }));
      await user.click(within(first).getByRole('button', { name: 'Show thinking' }));
      expect(within(first).getByText('First reasoning segment.')).toBeVisible();
      await act(async () => {
        call.release();
      });
      await waitFor(() => expect(second).toHaveTextContent('linear.list_relations'));
      expect(screen.getAllByTestId('assistant-activity-group')[0]).toBe(first);
      expect(screen.getAllByTestId('assistant-activity-group')[1]).toBe(second);
      expect(first).not.toHaveTextContent('linear.list_relations');
      await act(async () => {
        finish.release();
      });
      await screen.findByText('Review complete.');
      expectChronologicalGroups();
      expect(second).toHaveAttribute('data-active', 'false');
      expect(screen.getAllByTestId('assistant-activity-group')[0]).toBe(first);
      expect(screen.getAllByTestId('assistant-activity-group')[1]).toBe(second);
      expect(within(first).getByText('First reasoning segment.')).toBeVisible();
    } finally {
      await act(async () => {
        think.release();
        call.release();
        finish.release();
      });
    }
  }, 20_000);

  it('shows a persisted reasoning-only error as failed', async () => {
    render(
      <Harness
        adapter={{
          async run() {
            throw new Error('Must not invoke a model.');
          },
        }}
        initialMessages={[
          {
            content: [secondReasoning],
            role: 'assistant',
            status: { reason: 'error', type: 'incomplete' },
          },
        ]}
      />
    );
    await screen.findByText('Activity failed', { selector: HEADLINE_SELECTOR });
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-failed', 'true');
    // `headlineFor` never returns the literal "Worked" (it's always "Worked
    // for Ns" meta text next to the verb headline), so a bare
    // `queryByText('Worked', ...)` can never match and would silently pass
    // even for a broken failed-rule that renders the meta. Assert against
    // the group's full text content instead.
    expect(screen.getByTestId('assistant-activity-group')).not.toHaveTextContent('Worked for');
  });

  it('marks an explicit tool-result error in only its completed activity group', async () => {
    const content = completedParts.map((part) =>
      part.type === 'tool-call' && part.toolCallId === 'comments'
        ? { ...part, isError: true, result: { error: 'Tool refused.' } }
        : part
    );
    render(
      <Harness
        adapter={{
          async run() {
            throw new Error('Hydration must not invoke a model.');
          },
        }}
        initialMessages={[{ content, role: 'assistant' }]}
      />
    );
    await screen.findByText('Review complete.');
    const { first, second } = expectChronologicalGroups();
    expect(first).toHaveTextContent('Called linear.get_issue');
    expect(first).toHaveAttribute('data-failed', 'false');
    expect(first).not.toHaveTextContent('failed');
    expect(second).toHaveTextContent('Called linear.list_comments, called linear.list_relations');
    expect(second).toHaveTextContent('1 failed');
    expect(second).toHaveAttribute('data-failed', 'false');
  });

  it('preserves the same order and completed state when hydrated from persisted parts', async () => {
    const event = (toolCallId: string, timestamp: string, kind: string) => ({
      data: {
        id: timestamp,
        kind,
        label: 'tool',
        metadata: { toolCallId },
        status: 'completed',
        timestamp,
      },
      name: ASSISTANT_RUN_EVENT_DATA_NAME,
      type: 'data' as const,
    });
    const events = [
      event('first', '2026-09-05T10:00:00.000Z', 'tool.started'),
      event('first', '2026-09-05T10:00:02.000Z', 'tool.completed'),
      event('comments', '2026-09-05T10:00:10.000Z', 'tool.started'),
      event('comments', '2026-09-05T10:00:14.000Z', 'tool.completed'),
    ];
    render(
      <Harness
        adapter={{
          async run() {
            throw new Error('Hydration must not invoke a model.');
          },
        }}
        initialMessages={[{ content: [...completedParts, ...events], role: 'assistant' }]}
      />
    );
    await screen.findByText('Review complete.');
    const { first, second } = expectChronologicalGroups();
    expect(second).toHaveAttribute('data-active', 'false');
    expect(first).toHaveTextContent('1 step');
    expect(second).toHaveTextContent('2 steps');
    expect(first).toHaveTextContent('Worked for 2.0s');
    expect(second).toHaveTextContent('Worked for 4.0s');
  });

  it('keeps every tool call of a run in ONE group when run events fence each call (field shape)', async () => {
    render(
      <Harness
        adapter={{
          async run() {
            throw new Error('Hydration must not invoke a model.');
          },
        }}
        initialMessages={[{ content: completedPartsWithEvents, role: 'assistant' }]}
      />
    );
    await screen.findByText('Review complete.');
    const { first, second } = expectChronologicalGroups();
    expect(first).toHaveTextContent('1 step');
    expect(second).toHaveTextContent('2 steps');
    expect(first).toHaveTextContent('Worked for 2.0s');
    expect(second).toHaveTextContent('Worked for 4.0s');
  });

  it('renders a trailing data-only group (run.finished after the final text) bare, not as an empty "0 steps" card', async () => {
    const content = [
      ...completedPartsWithEvents,
      runEventPart({ id: 'e-fin', kind: 'run.finished', timestamp: '2026-09-05T10:00:15.000Z' }),
    ];
    render(
      <Harness
        adapter={{
          async run() {
            throw new Error('Hydration must not invoke a model.');
          },
        }}
        initialMessages={[{ content, role: 'assistant' }]}
      />
    );
    await screen.findByText('Review complete.');
    const groups = screen.getAllByTestId('assistant-activity-group');
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group).not.toHaveTextContent('0 steps');
    }
  });

  it('keeps grouping when run events fence each call LIVE, and settles into one summary', async () => {
    const finish = deferred();
    const adapter: ChatModelAdapter = {
      async *run() {
        yield { content: completedPartsWithEvents.slice(0, 9) };
        await finish.promise;
        yield { content: completedPartsWithEvents };
      },
    };
    const user = userEvent.setup();
    render(<Harness adapter={adapter} />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Inspect this issue.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('I found the issue.');
    const { second } = expectChronologicalGroups();
    expect(second).toHaveAttribute('data-active', 'true');
    await act(async () => {
      finish.release();
    });
    await screen.findByText('Review complete.');
    await waitFor(() => expect(second).toHaveAttribute('data-active', 'false'));
    expect(screen.getAllByTestId('assistant-activity-group')).toHaveLength(2);
    expect(second).toHaveTextContent('2 steps');
  }, 20_000);

  it('names the running tool in the header and settles into a verb summary', async () => {
    const finish = deferred();
    const adapter: ChatModelAdapter = {
      async *run() {
        // Through the comments call's `tool.started`, then the call itself
        // still resultless: the shape where the header must name the step.
        yield { content: [...completedPartsWithEvents.slice(0, 8), commentsTool] };
        await finish.promise;
        yield { content: completedPartsWithEvents };
      },
    };
    const user = userEvent.setup();
    render(<Harness adapter={adapter} />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('I found the issue.');
    const { second } = expectChronologicalGroups();
    expect(within(second).getByTestId('assistant-activity-working')).toHaveTextContent(
      'Calling linear.list_comments'
    );
    await act(async () => {
      finish.release();
    });
    await screen.findByText('Review complete.');
    await waitFor(() => expect(second).toHaveAttribute('data-state', 'done'));
    const summary = within(second).getByTestId('assistant-activity-summary');
    expect(summary).toHaveTextContent('Called linear.list_comments, called linear.list_relations');
    expect(summary).toHaveTextContent('Worked for');
    expect(summary).toHaveTextContent('2 steps');
  }, 20_000);

  it('names the running step in the detail line from its primary argument', async () => {
    const finish = deferred();
    const adapter: ChatModelAdapter = {
      async *run() {
        yield {
          content: [
            { text: 'Looking.', type: 'reasoning' as const },
            {
              args: { path: 'packages/db/src/registry.ts' },
              argsText: '{"path":"packages/db/src/registry.ts"}',
              toolCallId: 'read-1',
              toolName: 'brainstrike.readWorkspaceFile',
              type: 'tool-call' as const,
            },
          ],
        };
        await finish.promise;
      },
    };
    const user = userEvent.setup();
    render(<Harness adapter={adapter} />);
    try {
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      const group = await screen.findByTestId('assistant-activity-group');
      expect(within(group).getByTestId('assistant-activity-working')).toHaveTextContent(
        'Reading packages/db/src/registry.ts'
      );
      const detail = group.querySelector('.bs-trace-detail');
      expect(detail).not.toBeNull();
      expect(detail).toHaveTextContent('packages/db/src/registry.ts');
    } finally {
      await act(async () => {
        finish.release();
      });
    }
  }, 20_000);

  // BST-1681 task 5: every card in a group body renders the same L1 step row
  // — reasoning included — in part order, and the GROUP is what tells a row
  // whether it is the last running step. That fact cannot be derived by a
  // card from its own props: with two calls running in parallel, both would
  // otherwise shimmer. Scoped to `.bs-step-row-verb` on purpose: a running
  // card's TIMING slot legitimately carries its own shimmering progress
  // label, which is not what the last-running rule is about.
  it('renders one step row per card in part order, shimmering only the last running step', async () => {
    const { release, rows, verbs } = await renderRunningGroup([
      { text: 'Looking.', type: 'reasoning' },
      {
        args: { path: 'a.ts' },
        argsText: '{"path":"a.ts"}',
        result: { ok: true },
        toolCallId: 'read-a',
        toolName: 'brainstrike.readWorkspaceFile',
        type: 'tool-call',
      },
      {
        args: { path: 'b.ts' },
        argsText: '{"path":"b.ts"}',
        toolCallId: 'read-b',
        toolName: 'brainstrike.readWorkspaceFile',
        type: 'tool-call',
      },
      {
        args: { pattern: 'flag' },
        argsText: '{"pattern":"flag"}',
        toolCallId: 'grep-c',
        toolName: 'brainstrike.grepSearch',
        type: 'tool-call',
      },
    ]);
    try {
      expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
        'local-chain-of-thought',
        'activity-step-row',
        'activity-step-row',
        'activity-step-row',
      ]);
      expect(verbs.map((verb) => verb?.textContent)).toEqual([
        'Thought',
        'Read',
        'Reading',
        'Searching',
      ]);
      expect(verbs.map((verb) => verb?.classList.contains('bs-thinking-shimmer'))).toEqual([
        false,
        false,
        false,
        true,
      ]);
    } finally {
      await release();
    }
  }, 20_000);

  // Task 5 review, Important 3: the migrated cards (delegation, task list)
  // must hand the row their `toolCallId` as `stepId`, or the group's
  // last-running lookup misses them and the ONE row that should shimmer —
  // the group's last running step — is the one row that never does. Killing
  // test: a running delegation AFTER a running read, so "shimmer the last
  // running step" and "shimmer whatever is running" disagree.
  it("shimmers a running delegation row when it is the group's last running step", async () => {
    const { release, verbs } = await renderRunningGroup([
      { text: 'Looking.', type: 'reasoning' },
      {
        args: { path: 'b.ts' },
        argsText: '{"path":"b.ts"}',
        toolCallId: 'read-b',
        toolName: 'brainstrike.readWorkspaceFile',
        type: 'tool-call',
      },
      {
        args: { prompt: 'find the flag' },
        argsText: '{"prompt":"find the flag"}',
        toolCallId: 'delegate-d',
        toolName: 'agent-explore',
        type: 'tool-call',
      },
    ]);
    try {
      expect(verbs.map((verb) => verb?.textContent)).toEqual([
        'Thought',
        'Reading',
        'Explorer is working',
      ]);
      expect(verbs.map((verb) => verb?.classList.contains('bs-thinking-shimmer'))).toEqual([
        false,
        false,
        true,
      ]);
    } finally {
      await release();
    }
  }, 20_000);

  it("shimmers a running task-list row when it is the group's last running step", async () => {
    const { release, verbs } = await renderRunningGroup([
      { text: 'Looking.', type: 'reasoning' },
      {
        args: { path: 'b.ts' },
        argsText: '{"path":"b.ts"}',
        toolCallId: 'read-b',
        toolName: 'brainstrike.readWorkspaceFile',
        type: 'tool-call',
      },
      {
        args: { merge: true },
        argsText: '{"merge":true}',
        toolCallId: 'tasks-t',
        toolName: 'brainstrike.manageTaskList',
        type: 'tool-call',
      },
    ]);
    try {
      expect(verbs.map((verb) => verb?.textContent)).toEqual([
        'Thought',
        'Reading',
        'Updating tasks',
      ]);
      expect(verbs.map((verb) => verb?.classList.contains('bs-thinking-shimmer'))).toEqual([
        false,
        false,
        true,
      ]);
    } finally {
      await release();
    }
  }, 20_000);

  it('reads a model-written resting summary from message metadata when present', async () => {
    render(
      <Harness
        adapter={neverRunAdapter}
        initialMessages={[
          {
            content: completedParts,
            metadata: {
              custom: { brainstrikeActivitySummary: 'Pulled the issue and its comments' },
            },
            role: 'assistant',
          },
        ]}
      />
    );
    await screen.findByText('Review complete.');
    const [first] = screen.getAllByTestId('assistant-activity-group');
    if (!first) {
      throw new Error('Expected an activity group.');
    }
    expect(within(first).getByTestId('assistant-activity-summary')).toHaveTextContent(
      'Pulled the issue and its comments'
    );
  });

  // The override is validated on its TRIMMED value, so it must be RENDERED
  // trimmed too — otherwise a padded string passes the guard and paints its
  // padding into the headline (review finding 8).
  it('renders a model-written resting summary trimmed, not with its padding', async () => {
    render(
      <Harness
        adapter={neverRunAdapter}
        initialMessages={[
          {
            content: completedParts,
            metadata: { custom: { brainstrikeActivitySummary: '  Read files  ' } },
            role: 'assistant',
          },
        ]}
      />
    );
    await screen.findByText('Review complete.');
    const [first] = screen.getAllByTestId('assistant-activity-group');
    if (!first) {
      throw new Error('Expected an activity group.');
    }
    expect(first.querySelector(HEADLINE_SELECTOR)?.textContent).toBe('Read files');
  });
});

/**
 * PR #3061 review, Finding 1 (narrowed, fix round): `getGroupStatus` mirrors
 * the group's own LAST member part, so a group whose last member is a
 * transparent `tool.completed` run-event (not the message's last PART — a
 * trailing always-visible `run.cancelled`/`run.failed` standalone row follows
 * it) reads "complete" even when a RESULTLESS tool call earlier in the same
 * group carries the message's own `incomplete` status. The fix derives the
 * group's headline from its ACTIVITY parts (reasoning/tool-call) only, never
 * from a transparent data member — and, symmetrically, a group whose activity
 * parts ALL resolved (the tool call has a result) reads "Worked" even on a
 * cancelled/errored message: the standalone `run.*` row carries the run
 * outcome, the activity card reports what the activity itself did.
 */
describe('activity-part-derived group status (BST-1677 wave 3 fix round, PR #3061 finding 1)', () => {
  const neverRun = {
    async run() {
      throw new Error('Hydration must not invoke a model.');
    },
  };

  /**
   * The genuine masking shape: `tool.completed` is a GROUP-transparent data
   * part, but it is followed by an always-visible standalone row
   * (`run.cancelled`/`run.failed`, per `isAlwaysVisibleRunEvent`) that stays
   * OUTSIDE the group. That trailing standalone row means `tool.completed` is
   * no longer the message's own last PART, so the library's own
   * `toMessagePartStatus` no longer falls through to the message status for
   * it — its status resolves to `complete` regardless of the tool call's own
   * outcome. Without a trailing standalone row, `tool.completed` WOULD be the
   * message's last part and would already read the correct status by
   * construction, so this row is what makes the test actually exercise the
   * masking bug rather than passing by coincidence.
   */
  function trailingGroupContent(
    toolCallId: string,
    withResult: boolean,
    trailingKind: 'run.cancelled' | 'run.failed'
  ) {
    return [
      { text: 'Reasoning.', type: 'reasoning' as const },
      runEventPart({
        id: `e-${toolCallId}-s`,
        kind: 'tool.started',
        status: 'running' as const,
        timestamp: '2026-09-05T10:00:00.000Z',
        toolCallId,
      }),
      {
        args: {},
        argsText: '{}',
        ...(withResult ? { result: { ok: true } } : {}),
        toolCallId,
        toolName: `tool_${toolCallId}`,
        type: 'tool-call' as const,
      },
      runEventPart({
        id: `e-${toolCallId}-c`,
        kind: 'tool.completed',
        timestamp: '2026-09-05T10:00:01.000Z',
        toolCallId,
      }),
      runEventPart({
        id: `e-${toolCallId}-r`,
        kind: trailingKind,
        status: trailingKind === 'run.cancelled' ? ('cancelled' as const) : ('failed' as const),
        timestamp: '2026-09-05T10:00:02.000Z',
      }),
    ];
  }

  it('reads "Stopped" (not "Worked") when a resultless tool call is masked by a trailing tool.completed data part, message cancelled', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[
          {
            content: trailingGroupContent('x', false, 'run.cancelled'),
            role: 'assistant',
            status: { reason: 'cancelled', type: 'incomplete' },
          },
        ]}
      />
    );
    await screen.findByText('Stopped', { selector: HEADLINE_SELECTOR });
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-failed', 'false');
    expect(screen.getByTestId('assistant-activity-group')).not.toHaveTextContent('Worked for');
  });

  it('reads "Activity failed" (not "Worked") when a resultless tool call is masked by a trailing tool.completed data part, message errored', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[
          {
            content: trailingGroupContent('x', false, 'run.failed'),
            role: 'assistant',
            status: { reason: 'error', type: 'incomplete' },
          },
        ]}
      />
    );
    await screen.findByText('Activity failed', { selector: HEADLINE_SELECTOR });
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-failed', 'true');
    expect(screen.getByTestId('assistant-activity-group')).not.toHaveTextContent('Worked for');
  });

  it('reads "Worked" (not "Stopped") when the tool call HAS a result, even though the owning message was cancelled', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[
          {
            content: trailingGroupContent('x', true, 'run.cancelled'),
            role: 'assistant',
            status: { reason: 'cancelled', type: 'incomplete' },
          },
        ]}
      />
    );
    await screen.findByText('Used tool_x', { selector: HEADLINE_SELECTOR });
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-failed', 'false');
    expect(screen.queryByText('Stopped', { selector: HEADLINE_SELECTOR })).not.toBeInTheDocument();
  });

  it('two-group message: the resolved group reads "Worked", the unresolved trailing group reads "Stopped"', async () => {
    const content = [
      { text: 'First reasoning.', type: 'reasoning' as const },
      {
        args: {},
        argsText: '{}',
        result: { ok: true },
        toolCallId: 'a',
        toolName: 'tool_a',
        type: 'tool-call' as const,
      },
      runEventPart({
        id: 'e-a-c',
        kind: 'tool.completed',
        timestamp: '2026-09-05T10:00:00.500Z',
        toolCallId: 'a',
      }),
      { text: 'Between.', type: 'text' as const },
      runEventPart({
        id: 'e-b-s',
        kind: 'tool.started',
        status: 'running' as const,
        timestamp: '2026-09-05T10:00:01.000Z',
        toolCallId: 'b',
      }),
      {
        args: {},
        argsText: '{}',
        toolCallId: 'b',
        toolName: 'tool_b',
        type: 'tool-call' as const,
      },
    ];
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[
          { content, role: 'assistant', status: { reason: 'cancelled', type: 'incomplete' } },
        ]}
      />
    );
    await screen.findByText('Between.');
    const groups = screen.getAllByTestId('assistant-activity-group');
    expect(groups).toHaveLength(2);
    const [groupA, groupB] = groups;
    if (!(groupA && groupB)) {
      throw new Error('Expected two activity groups.');
    }
    expect(
      within(groupA).getByText('Used tool_a', { selector: HEADLINE_SELECTOR })
    ).toBeInTheDocument();
    expect(
      within(groupB).getByText('Stopped', { selector: HEADLINE_SELECTOR })
    ).toBeInTheDocument();
    // Group B's only call never settled, so it has no verb summary at all —
    // the placeholder must not surface as a demoted "· Worked" meta segment
    // beside "Stopped" (review finding 1). Now that the placeholder can no
    // longer reach the meta, this bare-word assertion is meaningful.
    expect(groupB).not.toHaveTextContent('Worked');
  });
});
