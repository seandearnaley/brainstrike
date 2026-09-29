/**
 * The panel reports its OWN run state to its owner (BST-1844) against a REAL
 * assistant-ui local runtime, so `thread.isRunning` makes genuine transitions.
 * The thread-tab workspace decides "close = hide" from this signal alone: the
 * durable run row lags the send and can outlive the run that wrote it.
 */
import '@testing-library/jest-dom/vitest';
import type { ChatModelAdapter } from '@assistant-ui/react';
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ThreadPrimitive,
  useLocalRuntime,
} from '@assistant-ui/react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RunningStateBridge } from '../running-state-bridge';

/** Each run() blocks until release(), so the thread is genuinely running in between. */
function createHeldAdapter() {
  const releases: Array<() => void> = [];
  const adapter: ChatModelAdapter = {
    async *run() {
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      yield { content: [{ text: 'done', type: 'text' as const }] };
    },
  };
  return { adapter, release: () => releases.shift()?.() };
}

function Harness({
  adapter,
  onRunningChange,
}: {
  adapter: ChatModelAdapter;
  onRunningChange: (threadKey: string, running: boolean) => void;
}) {
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RunningStateBridge onRunningChange={onRunningChange} threadKey="thread-1" />
      <ComposerPrimitive.Root>
        <ComposerPrimitive.Input aria-label="Message input" />
        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send aria-label="Send" />
        </ThreadPrimitive.If>
      </ComposerPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

describe('RunningStateBridge (real local runtime)', () => {
  it('reports each isRunning transition once', async () => {
    const user = userEvent.setup();
    const { adapter, release } = createHeldAdapter();
    const onRunningChange = vi.fn();
    render(<Harness adapter={adapter} onRunningChange={onRunningChange} />);
    expect(onRunningChange.mock.calls).toEqual([['thread-1', false]]);

    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(onRunningChange.mock.calls).toEqual([
        ['thread-1', false],
        ['thread-1', true],
      ])
    );

    release();
    await waitFor(() =>
      expect(onRunningChange.mock.calls).toEqual([
        ['thread-1', false],
        ['thread-1', true],
        ['thread-1', false],
      ])
    );
  });

  it('reports false when unmounted mid-run, so an owner never keeps a stale running flag', async () => {
    const user = userEvent.setup();
    const { adapter } = createHeldAdapter();
    const onRunningChange = vi.fn();
    const { unmount } = render(<Harness adapter={adapter} onRunningChange={onRunningChange} />);
    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onRunningChange).toHaveBeenLastCalledWith('thread-1', true));

    unmount();

    expect(onRunningChange).toHaveBeenLastCalledWith('thread-1', false);
  });
});
