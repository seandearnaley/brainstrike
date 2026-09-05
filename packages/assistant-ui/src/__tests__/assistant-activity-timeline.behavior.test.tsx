// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ChatModelAdapter } from '@assistant-ui/react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  completedParts,
  firstParts,
  Harness,
  secondReasoning,
  secondTools,
} from './assistant-activity-timeline-fixtures';

function deferred() {
  let release: () => void = () => {
    throw new Error('Deferred promise was not initialized.');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
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
  it('settles the active group on cancellation without reactivating earlier activity', async () => {
    const adapter: ChatModelAdapter = {
      async *run({ abortSignal }) {
        yield { content: [...firstParts, secondReasoning, ...secondTools] };
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
    expect(screen.getAllByTestId('assistant-activity-group')).toEqual([first, second]);
  });

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
      await waitFor(() => expect(second).toHaveTextContent('linear_list_relations'));
      expect(screen.getAllByTestId('assistant-activity-group')).toEqual([first, second]);
      expect(first).not.toHaveTextContent('linear_list_relations');
      await act(async () => {
        finish.release();
      });
      await screen.findByText('Review complete.');
      expectChronologicalGroups();
      expect(second).toHaveAttribute('data-active', 'false');
      expect(screen.getAllByTestId('assistant-activity-group')).toEqual([first, second]);
      expect(within(first).getByText('First reasoning segment.')).toBeVisible();
    } finally {
      await act(async () => {
        think.release();
        call.release();
        finish.release();
      });
    }
  }, 20_000);

  it('preserves the same order and completed state when hydrated from persisted parts', async () => {
    render(
      <Harness
        adapter={{
          async run() {
            throw new Error('Hydration must not invoke a model.');
          },
        }}
        initialMessages={[{ content: completedParts, role: 'assistant' }]}
      />
    );
    await screen.findByText('Review complete.');
    const { first, second } = expectChronologicalGroups();
    expect(second).toHaveAttribute('data-active', 'false');
    expect(first).toHaveTextContent('1 step');
    expect(second).toHaveTextContent('2 steps');
  });
});
