import '@testing-library/jest-dom/vitest';
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import './assistant-conversation-panel.browser.css';
import {
  type AssistantRuntime,
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  type ThreadMessageLike,
  useLocalRuntime,
} from '@assistant-ui/react';
import { TooltipProvider } from '@brainstrike/ui';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { ChatThreadUI } from '../assistant-ui-panel';
import { BrainstrikeDataStreamRuntimeAdapter } from '../data-stream-runtime';
import { resetFollowUpQueueStore, useFollowUpQueueStore } from '../follow-up-queue-store';
import { ACTIVITY_TRACE_CLOCK_INTERVAL_MS } from '../use-activity-trace-clock';
import { completedParts } from './assistant-activity-timeline-fixtures';

const onRunningChange = vi.fn();
const onToolApprovalRequired = vi.fn();
const onRunFinished = vi.fn();
beforeEach(() => {
  onRunningChange.mockClear();
  onToolApprovalRequired.mockClear();
  onRunFinished.mockClear();
});

const runtimes = new Map<string, AssistantRuntime>();
const adapters = new Map<string, ChatModelAdapter>();

function Panel({
  id,
  visible,
  initialMessages = [],
}: {
  id: string;
  visible: boolean;
  initialMessages?: ThreadMessageLike[];
}) {
  const adapter = adapters.get(id);
  if (!adapter) {
    throw new Error(`Missing adapter ${id}`);
  }
  const runtime = useLocalRuntime(adapter, { initialMessages });
  useEffect(() => {
    runtimes.set(id, runtime);
    return () => {
      runtimes.delete(id);
    };
  }, [id, runtime]);
  return (
    <div data-testid={id} hidden={!visible} style={{ height: 600, width: 700 }}>
      <AssistantRuntimeProvider runtime={runtime}>
        <ChatThreadUI
          disabledReason={undefined}
          fileMentions={[]}
          hasGroupedProviders={false}
          isComposerDisabled={false}
          isVisible={visible}
          onEnableModel={undefined}
          onFileMentionQueryChange={undefined}
          onModelChange={undefined}
          onRunFinished={onRunFinished}
          onRunningChange={onRunningChange}
          onToolApprovalRequired={onToolApprovalRequired}
          pickerModels={[]}
          providerGroups={[]}
          recentModels={undefined}
          selectedModel={undefined}
          selectedProvider={undefined}
          slashCommands={[]}
          threadKey={id}
        />
      </AssistantRuntimeProvider>
    </div>
  );
}

function Workspace({ firstVisible }: { firstVisible: boolean }) {
  return (
    <TooltipProvider>
      <Panel id="first" visible={firstVisible} />
      <Panel id="sibling" visible />
    </TooltipProvider>
  );
}

function event(id: string, kind: string, status: string): string {
  return `aui-data:${JSON.stringify({ data: { id, kind, label: kind, runId: 'run-first', status, timestamp: new Date().toISOString() }, name: 'brainstrike.run-event' })}`;
}

test('pauses hidden presentation clocks while both owned streams and hidden notifications continue', async () => {
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const intervals = new Set<number>();
  const browserTimers: Window = window;
  const originalSetInterval = browserTimers.setInterval.bind(browserTimers);
  const originalClearInterval = browserTimers.clearInterval.bind(browserTimers);
  vi.spyOn(browserTimers, 'setInterval').mockImplementation((handler, timeout, ...args) => {
    const id = originalSetInterval(handler, timeout, ...args);
    if (timeout === ACTIVITY_TRACE_CLOCK_INTERVAL_MS) {
      intervals.add(id);
    }
    return id;
  });
  vi.spyOn(browserTimers, 'clearInterval').mockImplementation((id) => {
    if (id !== undefined) {
      intervals.delete(id);
    }
    originalClearInterval(id);
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const id = url.includes('sibling') ? 'sibling' : 'first';
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.set(id, controller);
            },
          })
        )
      );
    })
  );
  onTestFinished(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    adapters.clear();
  });
  for (const id of ['first', 'sibling']) {
    adapters.set(
      id,
      new BrainstrikeDataStreamRuntimeAdapter({ api: `http://assistant.test/${id}` })
    );
  }
  const view = render(<Workspace firstVisible />);
  await waitFor(() => expect(runtimes.size).toBe(2));
  await act(async () => {
    for (const runtime of runtimes.values()) {
      runtime.thread.append('Inspect the read path.');
    }
  });
  await waitFor(() => expect(streams.size).toBe(2));
  function emit(id: string, ...frames: string[]): void {
    const stream = streams.get(id);
    if (!stream) {
      throw new Error(`Missing stream ${id}`);
    }
    stream.enqueue(encoder.encode(`${frames.join('\n')}\n`));
  }
  await act(async () => {
    for (const id of ['first', 'sibling']) {
      emit(
        id,
        `f:{"messageId":"${id}-assistant"}`,
        event(`${id}-start`, 'run.started', 'running'),
        'g:"Inspecting the workspace."'
      );
    }
  });
  await waitFor(() => expect(intervals.size).toBe(2));
  const first = within(view.getByTestId('first'));
  const input = first.getByRole('textbox', { name: 'Message input' });
  fireEvent.change(input, { target: { value: 'Retained draft' } });
  const viewport = first.getByTestId('assistant-ui-viewport');
  view.rerender(<Workspace firstVisible={false} />);
  await waitFor(() => expect(intervals.size).toBe(1));
  expect(runtimes.get('first')?.thread.getState().isRunning).toBe(true);
  expect(runtimes.get('sibling')?.thread.getState().isRunning).toBe(true);
  await act(async () => {
    emit(
      'first',
      `aui-data:${JSON.stringify({ data: { args: { path: 'README.md' }, riskCategory: 'read', runId: 'run-first', toolCallId: 'read-first', toolName: 'brainstrike.readWorkspaceFile' }, name: 'brainstrike.tool-approval' })}`
    );
  });
  await waitFor(() =>
    expect(onToolApprovalRequired).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'read-first' })
    )
  );
  await act(async () => {
    emit(
      'first',
      '9:{"toolCallId":"read-first","toolName":"brainstrike.readWorkspaceFile","args":{"path":"README.md"}}',
      'a:{"toolCallId":"read-first","result":{"content":"Verified read output"}}',
      '0:"Read complete while hidden."',
      event('first-finish', 'run.finished', 'completed'),
      'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1},"path":[]}'
    );
    streams.get('first')?.close();
  });
  await waitFor(() =>
    expect(onRunFinished).toHaveBeenCalledWith(expect.objectContaining({ id: 'first-finish' }))
  );
  await waitFor(() => expect(onRunningChange).toHaveBeenCalledWith('first', false));
  expect(runtimes.get('sibling')?.thread.getState().isRunning).toBe(true);
  expect(intervals.size).toBe(1);
  await act(async () => {
    emit('sibling', '0:"Sibling still producing output."');
  });
  view.rerender(<Workspace firstVisible />);
  await waitFor(() => expect(first.getByText('Read complete while hidden.')).toBeVisible());
  expect(first.getByRole('textbox', { name: 'Message input' })).toBe(input);
  expect(input).toHaveValue('Retained draft');
  expect(first.getByTestId('assistant-ui-viewport')).toBe(viewport);
  await act(async () => {
    emit(
      'sibling',
      'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1},"path":[]}'
    );
    streams.get('sibling')?.close();
  });
  await waitFor(() => expect(intervals.size).toBe(0));
});

const history: ThreadMessageLike[] = Array.from({ length: 80 }, (_, index) => ({
  content: index === 0 ? completedParts : [{ text: `Retained evidence ${index}.`, type: 'text' }],
  id: `history-${index}`,
  role: 'assistant',
  status: { reason: 'stop', type: 'complete' },
}));

test('retains transcript DOM, draft, disclosure, and reader scroll across hidden presentation', async () => {
  adapters.set(
    'history',
    new BrainstrikeDataStreamRuntimeAdapter({ api: 'http://assistant.test/history' })
  );
  onTestFinished(() => adapters.clear());
  const content = (visible: boolean) => (
    <TooltipProvider>
      <Panel id="history" initialMessages={history} visible={visible} />
    </TooltipProvider>
  );
  const view = render(content(true));
  const panel = within(view.getByTestId('history'));
  const viewport = panel.getByTestId('assistant-ui-viewport');
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await panel.findByText('Retained evidence 79.');
  const group = panel.getAllByTestId('assistant-activity-group')[0];
  if (!group) {
    throw new Error('Expected saved activity.');
  }
  const disclosure = within(group).getByRole('button', { name: 'Expand activity' });
  fireEvent.click(disclosure);
  fireEvent.click(within(group).getByRole('button', { name: 'Show thinking' }));
  fireEvent.change(input, { target: { value: 'Preserve this draft' } });
  await act(async () => {
    viewport.scrollTo({ behavior: 'instant', top: viewport.scrollHeight });
  });
  await waitFor(() =>
    expect(
      Math.abs(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight)
    ).toBeLessThanOrEqual(2)
  );
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });
  });
  fireEvent.wheel(viewport, { deltaY: -600 });
  await act(async () => {
    viewport.scrollTo({ behavior: 'instant', top: 160 });
  });
  fireEvent.scroll(viewport);
  await waitFor(() => expect(Math.abs(viewport.scrollTop - 160)).toBeLessThanOrEqual(2));
  await waitFor(() =>
    expect(viewport.closest('.bs-thread-scroll-region')).not.toHaveAttribute('data-pinned')
  );
  const savedTop = viewport.scrollTop;
  view.rerender(content(false));
  expect(input).not.toBeVisible();
  view.rerender(content(true));
  await waitFor(() => expect(input).toBeVisible());
  expect(panel.getByTestId('assistant-ui-viewport')).toBe(viewport);
  expect(panel.getByRole('textbox', { name: 'Message input' })).toBe(input);
  expect(input).toHaveValue('Preserve this draft');
  expect(panel.getAllByTestId('assistant-activity-group')[0]).toBe(group);
  expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await waitFor(() => expect(within(group).getByText('First reasoning segment.')).toBeVisible());
  await waitFor(() => expect(Math.abs(viewport.scrollTop - savedTop)).toBeLessThanOrEqual(2));
});

test('dispatches a queued follow-up from the existing hidden runtime owner', async () => {
  const inputs: string[] = [];
  const releases: Array<() => void> = [];
  adapters.set('queued', {
    async *run({ messages }) {
      inputs.push(
        messages
          .at(-1)
          ?.content.map((part) => (part.type === 'text' ? part.text : ''))
          .join('') ?? ''
      );
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      yield { content: [{ text: 'Finished owned turn.', type: 'text' }] };
    },
  });
  resetFollowUpQueueStore();
  onTestFinished(() => {
    adapters.clear();
    resetFollowUpQueueStore();
  });
  const content = (visible: boolean) => (
    <TooltipProvider>
      <Panel id="queued" visible={visible} />
    </TooltipProvider>
  );
  const view = render(content(true));
  await waitFor(() => expect(runtimes.has('queued')).toBe(true));
  await act(async () => {
    runtimes.get('queued')?.thread.append('First owned turn');
  });
  await waitFor(() => expect(inputs).toEqual(['First owned turn']));
  view.rerender(content(false));
  await act(async () => {
    useFollowUpQueueStore.getState().enqueue('queued', 'Follow-up while hidden');
    releases.shift()?.();
  });
  await waitFor(() => expect(inputs).toEqual(['First owned turn', 'Follow-up while hidden']));
  expect(runtimes.get('queued')?.thread.getState().isRunning).toBe(true);
  await act(async () => {
    releases.shift()?.();
  });
  await waitFor(() => expect(runtimes.get('queued')?.thread.getState().isRunning).toBe(false));
});
