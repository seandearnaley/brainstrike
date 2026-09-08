// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ChatModelAdapter } from '@assistant-ui/react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
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
    expect(await screen.findByTestId('assistant-reasoning-indicator')).toHaveTextContent(
      'Thinking'
    );
    expect(screen.getByTestId('assistant-reasoning-static-mark')).toHaveClass(
      'bs-thinking-mark-static'
    );
    expect(screen.queryByTestId('assistant-thinking-indicator')).not.toBeInTheDocument();
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

      const fold = (await screen.findAllByTestId('local-chain-of-thought'))[0];
      if (!fold) {
        throw new Error('Expected a reasoning toggle.');
      }
      expect(within(fold).getByTestId('assistant-thinking-indicator')).toBeInTheDocument();
      const mark = within(fold).getByTestId('assistant-thinking-mark');
      expect(mark).toHaveAttribute('data-tone', 'greyscale');
      expect(mark).toHaveAttribute('data-live', 'true');
      expect(within(fold).queryByTestId('assistant-reasoning-static-mark')).toBeNull();
      expect(fold).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('Thinking hard.')).toBeVisible();
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

      const fold = (await screen.findAllByTestId('local-chain-of-thought'))[0];
      if (!fold) {
        throw new Error('Expected a reasoning toggle.');
      }
      const staticMark = within(fold).getByTestId('assistant-reasoning-static-mark');
      expect(staticMark).toHaveClass('bs-thinking-mark-static');
      expect(staticMark).toHaveAttribute('data-live', 'false');
      // Scoped to the fold: a running tool card legitimately renders its own
      // thinking indicator elsewhere in the document, and the message-level
      // `indicator="no-text"` placeholder also renders while the message runs
      // and its last part is not text/reasoning, so asserting on `screen`
      // directly here would be a false negative for this check.
      expect(within(fold).queryByTestId('assistant-thinking-indicator')).toBeNull();
      expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-active', 'true');
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
});
