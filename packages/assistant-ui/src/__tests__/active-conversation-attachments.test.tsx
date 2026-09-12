// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {
  type AssistantRuntime,
  AssistantRuntimeProvider,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import type { AssistantChildInput } from '@brainstrike/assistant-contract';
import { TooltipProvider } from '@brainstrike/ui';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useMemo } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ActiveConversationInputProvider } from '../active-conversation-input';
import { useActiveConversationInput } from '../active-conversation-input-context';
import { AssistantConversationPanel } from '../assistant-conversation-panel';
import { createAssistantImageAttachmentAdapter } from '../attachment-adapter';

function Controls() {
  const input = useActiveConversationInput();
  return (
    <>
      <button onClick={() => input?.send()} type="button">
        Send child
      </button>
      <button onClick={() => input?.discard()} type="button">
        Discard
      </button>
      <p>{input?.error}</p>
    </>
  );
}
function Harness({
  onSend,
  prepare,
  capture,
  panel = false,
  running = true,
}: {
  prepare?: (input: AssistantChildInput) => AssistantChildInput;
  panel?: boolean;
  running?: boolean;
  onSend: (input: AssistantChildInput) => Promise<void>;
  capture: (runtime: AssistantRuntime) => void;
}) {
  const attachments = useMemo(createAssistantImageAttachmentAdapter, []);
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    adapters: { attachments },
    convertMessage: (message) => message,
    isRunning: running,
    messages: [],
    onNew: async () => {},
  });
  useEffect(() => capture(runtime), [capture, runtime]);
  if (panel) {
    return (
      <TooltipProvider>
        <AssistantConversationPanel
          allowIdleInput
          attachmentsAvailability={{ state: 'enabled' }}
          label="Cedar"
          onSendActiveInput={onSend}
          prepareActiveInput={prepare}
          runtime={runtime}
          threadKey="child"
        />
      </TooltipProvider>
    );
  }
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ActiveConversationInputProvider onSend={onSend} prepare={prepare}>
        <Controls />
      </ActiveConversationInputProvider>
    </AssistantRuntimeProvider>
  );
}
const file = (name = 'first.png') => new File(['image'], name, { type: 'image/png' });
function setup(
  onSend: (input: AssistantChildInput) => Promise<void>,
  panel = false,
  running = true
) {
  let current: AssistantRuntime | undefined;
  render(
    <Harness
      capture={(runtime) => {
        current = runtime;
      }}
      onSend={onSend}
      panel={panel}
      running={running}
    />
  );
  if (!current) {
    throw new Error('No public runtime');
  }
  return current;
}
afterEach(cleanup);

it('sends an image-only child input and clears it only after acknowledgement', async () => {
  const delivery = Promise.withResolvers<void>();
  const send = vi.fn<(input: AssistantChildInput) => Promise<void>>(() => delivery.promise);
  const runtime = setup(send);
  await act(() => runtime.thread.composer.addAttachment(file()));
  await userEvent.click(screen.getByRole('button', { name: 'Send child' }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]?.[0]).toMatchObject({
    attachments: [
      {
        data: 'data:image/png;base64,aW1hZ2U=',
        filename: 'first.png',
        mediaType: 'image/png',
        type: 'file',
      },
    ],
    text: '',
  });
  expect(runtime.thread.composer.getState().attachments).toHaveLength(1);
  await act(async () => {
    delivery.resolve();
    await delivery.promise;
  });
  await waitFor(() => expect(runtime.thread.composer.getState().attachments).toHaveLength(0));
});

it('retains the complete failed receipt and refuses changed attachments until explicit discard', async () => {
  const send = vi
    .fn<(input: AssistantChildInput) => Promise<void>>()
    .mockRejectedValue(new Error('Unconfirmed'));
  const runtime = setup(send);
  await act(async () => {
    runtime.thread.composer.setText('Inspect');
    await runtime.thread.composer.addAttachment(file());
  });
  await userEvent.click(screen.getByRole('button', { name: 'Send child' }));
  await screen.findByText('Unconfirmed');
  expect(send.mock.calls[0]?.[0].attachments).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: 'Send child' }));
  expect(send.mock.calls[1]?.[0]).toEqual(send.mock.calls[0]?.[0]);
  await act(() => runtime.thread.composer.addAttachment(file('second.png')));
  await userEvent.click(screen.getByRole('button', { name: 'Send child' }));
  await screen.findByText(/earlier input is unconfirmed/);
  expect(send).toHaveBeenCalledTimes(2);
  expect(runtime.thread.composer.getState().attachments).toHaveLength(2);
  await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
  await waitFor(() => expect(runtime.thread.composer.getState().attachments).toHaveLength(0));
});

it('preserves a newer staged attachment and text when an older send is acknowledged', async () => {
  const delivery = Promise.withResolvers<void>();
  const send = vi.fn<(input: AssistantChildInput) => Promise<void>>(() => delivery.promise);
  const runtime = setup(send);
  await act(async () => {
    runtime.thread.composer.setText('First');
    await runtime.thread.composer.addAttachment(file());
  });
  await userEvent.click(screen.getByRole('button', { name: 'Send child' }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  await act(async () => {
    runtime.thread.composer.setText('Next');
    await runtime.thread.composer.addAttachment(file('next.png'));
  });
  await act(async () => {
    delivery.resolve();
    await delivery.promise;
  });
  await waitFor(() =>
    expect(runtime.thread.composer.getState().attachments.map((item) => item.name)).toEqual([
      'next.png',
    ])
  );
  expect(runtime.thread.composer.getState().text).toBe('Next');
});

it.each([true, false])(
  'enables image-only input through the shared panel while running=%s',
  async (running) => {
    const send = vi
      .fn<(input: AssistantChildInput) => Promise<void>>()
      .mockResolvedValue(undefined);
    const runtime = setup(send, true, running);
    const button = screen.getByRole('button', {
      name: running ? 'Send to child' : 'Send',
    });
    expect(button).toBeDisabled();
    await act(() => runtime.thread.composer.addAttachment(file()));
    expect(button).toBeEnabled();
    await userEvent.click(button);
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      attachments: [{ filename: 'first.png' }],
      text: '',
    });
    await waitFor(() => expect(button).toBeDisabled());
    await act(() => runtime.thread.composer.addAttachment(file('keyboard.png')));
    await userEvent.type(screen.getByRole('textbox'), '{Enter}');
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      attachments: [{ filename: 'keyboard.png' }],
      text: '',
    });
  }
);

it('clears delivered text independently when only a newer image was staged', async () => {
  const delivery = Promise.withResolvers<void>();
  const send = vi.fn<(input: AssistantChildInput) => Promise<void>>(() => delivery.promise);
  const runtime = setup(send);
  await act(() => runtime.thread.composer.setText('Already delivered'));
  await userEvent.click(screen.getByRole('button', { name: 'Send child' }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  await act(() => runtime.thread.composer.addAttachment(file('next.png')));
  await act(async () => {
    delivery.resolve();
    await delivery.promise;
  });
  await waitFor(() => expect(runtime.thread.composer.getState().text).toBe(''));
  expect(runtime.thread.composer.getState().attachments.map((item) => item.name)).toEqual([
    'next.png',
  ]);
});

it('freezes next-run controls once and retries the same receipt after controls change', async () => {
  let current: AssistantRuntime | undefined;
  const capture = (runtime: AssistantRuntime) => {
    current = runtime;
  };
  const send = vi
    .fn<(input: AssistantChildInput) => Promise<void>>()
    .mockRejectedValueOnce(new Error('Unconfirmed'))
    .mockResolvedValue(undefined);
  const prepare = vi.fn(
    (input: AssistantChildInput): AssistantChildInput => ({
      ...input,
      nextRun: { modelSettings: { maxOutputTokens: 777 } },
    })
  );
  const view = render(<Harness capture={capture} onSend={send} prepare={prepare} />);
  if (!current) {
    throw new Error('Missing runtime');
  }
  act(() => current?.thread.composer.setText('Continue'));
  await userEvent.click(screen.getByRole('button', { name: 'Send child' }));
  expect(await screen.findByText('Unconfirmed')).toBeVisible();
  const changedPrepare = vi.fn(
    (input: AssistantChildInput): AssistantChildInput => ({
      ...input,
      nextRun: { modelSettings: { maxOutputTokens: 42 } },
    })
  );
  view.rerender(<Harness capture={capture} onSend={send} prepare={changedPrepare} />);
  await userEvent.click(screen.getByRole('button', { name: 'Send child' }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls[0]?.[0]).toMatchObject({
    nextRun: { modelSettings: { maxOutputTokens: 777 } },
  });
  expect(send.mock.calls[1]?.[0]).toEqual(send.mock.calls[0]?.[0]);
  expect(prepare).toHaveBeenCalledOnce();
  expect(changedPrepare).not.toHaveBeenCalled();
});
