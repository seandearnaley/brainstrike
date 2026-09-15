/**
 * Behavior coverage for the follow-up queue (report R3 v1) against a REAL
 * assistant-ui local runtime — genuine isRunning transitions, no mocked aui
 * state. Proves the v1 contract: text queued DURING a run shows a removable
 * chip, is dispatched as a real user message when the run ends (one per run
 * end, FIFO), and a removed chip is never dispatched.
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
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FollowUpQueueBridge,
  FollowUpQueueChips,
  QueueFollowUpButton,
  SteerRunButton,
} from '../follow-up-queue';
import {
  followUpQueueKey,
  resetFollowUpQueueStore,
  useFollowUpQueueStore,
} from '../follow-up-queue-store';
import { ThreadScrollFollowProvider } from '../thread-scroll-follow';

/** A controllable adapter: each run() blocks until its release() is called, so
 * the thread is GENUINELY running in between. Records every run's last user
 * message text. */
function createControllableAdapter() {
  const releases: Array<() => void> = [];
  const runInputs: string[] = [];
  const adapter: ChatModelAdapter = {
    async *run({ messages }) {
      const lastUser = [...messages].reverse().find((message) => message.role === 'user');
      const text =
        lastUser?.content.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? '';
      runInputs.push(text);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      yield { content: [{ text: `echo: ${text}`, type: 'text' as const }] };
    },
  };
  return {
    adapter,
    release: () => releases.shift()?.(),
    runInputs,
  };
}

function Harness({
  adapter,
  threadKey,
  bridgeMounted = true,
  onSteerRequest,
}: {
  adapter: ChatModelAdapter;
  threadKey: string;
  bridgeMounted?: boolean;
  onSteerRequest?: () => Promise<boolean>;
}) {
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadScrollFollowProvider>
        {bridgeMounted ? <FollowUpQueueBridge threadKey={threadKey} /> : null}
        <FollowUpQueueChips threadKey={threadKey} />
        <ComposerPrimitive.Root>
          <ComposerPrimitive.Input aria-label="Message input" />
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send aria-label="Send" />
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <QueueFollowUpButton threadKey={threadKey} />
            {onSteerRequest ? (
              <SteerRunButton onSteerRequest={onSteerRequest} threadKey={threadKey} />
            ) : null}
          </ThreadPrimitive.If>
        </ComposerPrimitive.Root>
      </ThreadScrollFollowProvider>
    </AssistantRuntimeProvider>
  );
}

describe('follow-up queue behavior (real local runtime)', () => {
  beforeEach(() => {
    resetFollowUpQueueStore();
  });

  it('steers during a run: enqueues at the FRONT, fires the steer request, dispatches first on run end (BST-588)', async () => {
    const user = userEvent.setup();
    const { adapter, release, runInputs } = createControllableAdapter();
    const steerCalls: number[] = [];
    const onSteerRequest = () => {
      steerCalls.push(Date.now());
      return Promise.resolve(true);
    };
    render(<Harness adapter={adapter} onSteerRequest={onSteerRequest} threadKey="t-steer" />);

    const input = screen.getByRole('textbox', { name: 'Message input' });
    await user.type(input, 'first message');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    // Genuinely running: queue an ordinary follow-up FIRST, then steer.
    await screen.findByTestId('assistant-queue-follow-up');
    await user.type(input, 'passive follow-up');
    await user.click(screen.getByTestId('assistant-queue-follow-up'));

    await user.type(input, 'steer: change course');
    await user.click(screen.getByTestId('assistant-steer-run'));

    // Steer request fired once; composer cleared; both chips visible.
    expect(steerCalls).toHaveLength(1);
    expect(input).toHaveValue('');
    const chips = screen.getAllByTestId('assistant-follow-up-chip');
    expect(chips.map((chip) => chip.textContent)).toEqual([
      expect.stringContaining('steer: change course'),
      expect.stringContaining('passive follow-up'),
    ]);

    // Run ends (the server would end it at the next step boundary) — the
    // steer message dispatches FIRST.
    release();
    await waitFor(() => {
      expect(runInputs).toEqual(['first message', 'steer: change course']);
    });
    release();
    await waitFor(() => {
      expect(runInputs).toEqual(['first message', 'steer: change course', 'passive follow-up']);
    });
    release();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    });
  });

  it('a steer whose control request fails keeps the message queued (dispatches on natural run end)', async () => {
    const user = userEvent.setup();
    const { adapter, release, runInputs } = createControllableAdapter();
    const onSteerRequest = () => Promise.reject(new Error('server unreachable'));
    render(<Harness adapter={adapter} onSteerRequest={onSteerRequest} threadKey="t-steer-fail" />);

    const input = screen.getByRole('textbox', { name: 'Message input' });
    await user.type(input, 'first message');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByTestId('assistant-steer-run');
    await user.type(input, 'steer anyway');
    await user.click(screen.getByTestId('assistant-steer-run'));

    // The message is never lost: chip stays queued despite the failed control
    // request, and dispatches when the run ends naturally.
    expect(screen.getByTestId('assistant-follow-up-chip')).toHaveTextContent('steer anyway');
    release();
    await waitFor(() => {
      expect(runInputs).toEqual(['first message', 'steer anyway']);
    });
    release();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    });
  });

  it('queues during a run, shows a chip, and auto-dispatches on run end', async () => {
    const user = userEvent.setup();
    const { adapter, release, runInputs } = createControllableAdapter();
    render(<Harness adapter={adapter} threadKey="t-queue" />);

    const input = screen.getByRole('textbox', { name: 'Message input' });
    await user.type(input, 'first message');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    // Run 1 is genuinely in flight: the queue control replaced Send.
    const queueButton = await screen.findByTestId('assistant-queue-follow-up');
    await user.type(input, 'queued follow-up');
    await user.click(queueButton);

    // Chip shown, composer cleared, nothing dispatched yet.
    expect(screen.getByTestId('assistant-follow-up-chip')).toHaveTextContent('queued follow-up');
    expect(input).toHaveValue('');
    expect(runInputs).toEqual(['first message']);

    // Run 1 ends -> the queued message dispatches as a REAL user message.
    release();
    await waitFor(() => {
      expect(runInputs).toEqual(['first message', 'queued follow-up']);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('assistant-follow-up-chip')).not.toBeInTheDocument();
    });
    // Let the follow-up run finish too so nothing leaks across tests.
    release();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    });
  });

  it('dispatches a queued DECISION message with its run config when the run ends', async () => {
    const user = userEvent.setup();
    const { adapter, release, runInputs } = createControllableAdapter();
    render(<Harness adapter={adapter} threadKey="t-decision" />);
    const input = screen.getByRole('textbox', { name: 'Message input' });
    await user.type(input, 'first message');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByTestId('assistant-queue-follow-up');
    // A card's decision during the run lands here (decision-dispatch.ts).
    useFollowUpQueueStore.getState().enqueueMessage(followUpQueueKey('t-decision'), {
      identityKey: '["run","call"]',
      message: {
        content: [{ text: 'Approved brainstrike.grepSearch.', type: 'text' }],
        role: 'user',
        runConfig: { custom: { brainstrikeToolApproval: { action: 'approve' } } },
        startRun: true,
      },
      text: 'Approved brainstrike.grepSearch.',
    });
    expect(await screen.findByTestId('assistant-follow-up-chip')).toHaveTextContent(
      'Approved brainstrike.grepSearch.'
    );
    expect(runInputs).toEqual(['first message']);
    release();
    await waitFor(() => {
      expect(runInputs).toEqual(['first message', 'Approved brainstrike.grepSearch.']);
    });
    release();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    });
  });

  it('dispatches queued messages one per run end, FIFO', async () => {
    const user = userEvent.setup();
    const { adapter, release, runInputs } = createControllableAdapter();
    render(<Harness adapter={adapter} threadKey="t-fifo" />);

    const input = screen.getByRole('textbox', { name: 'Message input' });
    await user.type(input, 'first message');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const queueButton = await screen.findByTestId('assistant-queue-follow-up');
    await user.type(input, 'second');
    await user.click(queueButton);
    await user.type(input, 'third');
    await user.click(queueButton);
    expect(screen.getAllByTestId('assistant-follow-up-chip')).toHaveLength(2);

    release();
    await waitFor(() => {
      expect(runInputs).toEqual(['first message', 'second']);
    });
    // 'third' stays queued while 'second' runs.
    expect(screen.getAllByTestId('assistant-follow-up-chip')).toHaveLength(1);

    release();
    await waitFor(() => {
      expect(runInputs).toEqual(['first message', 'second', 'third']);
    });
    release();
    await waitFor(() => {
      expect(screen.queryByTestId('assistant-follow-up-chip')).not.toBeInTheDocument();
    });
  });

  it('a removed chip is never dispatched', async () => {
    const user = userEvent.setup();
    const { adapter, release, runInputs } = createControllableAdapter();
    render(<Harness adapter={adapter} threadKey="t-remove" />);

    const input = screen.getByRole('textbox', { name: 'Message input' });
    await user.type(input, 'first message');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const queueButton = await screen.findByTestId('assistant-queue-follow-up');
    await user.type(input, 'changed my mind');
    await user.click(queueButton);
    await user.click(screen.getByTestId('assistant-follow-up-chip-remove'));
    expect(screen.queryByTestId('assistant-follow-up-chip')).not.toBeInTheDocument();

    release();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    });
    expect(runInputs).toEqual(['first message']);
  });

  it('dispatches a queued message whose run ended while the bridge was unmounted (missed run end)', async () => {
    // The bridge lives inside a threadKey-keyed subtree: switching threads
    // unmounts it, so a run that ends off-screen produces NO observable
    // transition. On (re)mount over an IDLE thread with a non-empty queue,
    // the bridge must treat that as a missed run end and dispatch — the chip
    // promised "sends when the current run ends", and the run HAS ended.
    const user = userEvent.setup();
    const { adapter, release, runInputs } = createControllableAdapter();
    const view = render(<Harness adapter={adapter} threadKey="t-missed" />);

    const input = screen.getByRole('textbox', { name: 'Message input' });
    await user.type(input, 'first message');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const queueButton = await screen.findByTestId('assistant-queue-follow-up');
    await user.type(input, 'queued while away');
    await user.click(queueButton);

    // "Thread switch": the bridge unmounts while the run is still active…
    view.rerender(<Harness adapter={adapter} bridgeMounted={false} threadKey="t-missed" />);
    // …the run ends with no bridge watching…
    release();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    });
    expect(runInputs).toEqual(['first message']);

    // …and the user switches back: the remounted bridge catches up.
    view.rerender(<Harness adapter={adapter} bridgeMounted={true} threadKey="t-missed" />);
    await waitFor(() => {
      expect(runInputs).toEqual(['first message', 'queued while away']);
    });
    release();
    await waitFor(() => {
      expect(screen.queryByTestId('assistant-follow-up-chip')).not.toBeInTheDocument();
    });
  });

  it('disables the queue control for whitespace-only drafts', async () => {
    const user = userEvent.setup();
    const { adapter, release } = createControllableAdapter();
    render(<Harness adapter={adapter} threadKey="t-empty" />);

    const input = screen.getByRole('textbox', { name: 'Message input' });
    await user.type(input, 'first message');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const queueButton = await screen.findByTestId('assistant-queue-follow-up');
    expect(queueButton).toBeDisabled();
    await user.type(input, '   ');
    expect(queueButton).toBeDisabled();

    release();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    });
  });
});
