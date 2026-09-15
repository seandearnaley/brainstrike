/**
 * A root Stop re-reads the thread's pauses from the host ledger (BST-1749
 * review finding: a cancelled pause stayed "Pending" in-session).
 *
 * While a dispatching turn is still open, a background child's parked read
 * publishes a ROOT card into the live stream. An explicit root Stop cancels
 * that paused work on the host ("Explicit root Stop shuts native admission,
 * cancels queued/paused/running work", assistant-runtime.md), but nothing in
 * the renderer learned it: the approval part stayed in the cancelled message,
 * so the card read "Pending" with live buttons and the composer strip kept
 * counting "1 approval waiting" until the thread was reloaded. The durable
 * decision state only arrives through rediscovery on history load.
 *
 * Real `AssistantUiPanel`, real data-stream adapter and run session, real
 * approvals index, strip and notice. Only the host is stubbed: the stream and
 * `/assistant/cancel` fetches, and a mutable history source that returns what
 * rediscovery returns after the cancel settled.
 */
import '@testing-library/jest-dom/vitest';
import {
  ExportedMessageRepository,
  type ThreadHistoryAdapter,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import {
  ASSISTANT_STREAM_EVENT_ID_HEADER,
  ASSISTANT_STREAM_MESSAGE_ID_HEADER,
} from '@brainstrike/assistant-contract';
import {
  type AssistantToolApprovalRequest,
  TOOL_APPROVAL_DATA_NAME,
} from '@brainstrike/assistant-contract/tool-approval';
import { TooltipProvider } from '@brainstrike/ui';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type PropsWithChildren, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../assistant-message-text', () => ({
  AssistantMessageText: () => <div data-testid="markdown-text" />,
  preloadMarkdownText: vi.fn().mockResolvedValue(undefined),
  UserMessageText: () => <div data-testid="markdown-text" />,
}));
vi.mock('@assistant-ui/styles/index.css', () => ({}));
vi.mock('../local-runtime-adapter', () => ({
  createLocalModelAdapter: vi.fn(() => ({ run: vi.fn() })),
  disposeLocalBackend: vi.fn().mockResolvedValue(undefined),
  hasDesktopLlmHost: vi.fn(() => false),
}));

import { AssistantUiPanel, type AssistantUiPanelProps } from '../assistant-ui-panel';
import type { ComposerDraftCommand } from '../composer-draft-command';
import { RewindProvider } from '../rewind-context';

type PanelRuntime = Parameters<NonNullable<AssistantUiPanelProps['onRuntimeReady']>>[0];

const BASE = 'http://127.0.0.1:43123';
const THREAD_KEY = 'thread-root-stop';
const RUN_ID = 'run-root-stop-1';

/** The root card a parked background Explorer's read publishes into the open turn. */
const LIVE_PAUSE: AssistantToolApprovalRequest = {
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
  policyDecision: 'ask',
  riskCategory: 'read',
  runId: 'root-run',
  toolCallId: 'delegate-1',
  toolName: 'brainstrike.grepSearch',
};

function textMessage(id: string, role: 'assistant' | 'user', text: string): ThreadMessageLike {
  const message = { content: [{ text, type: 'text' }] as const, id };
  return role === 'assistant'
    ? { ...message, role, status: { reason: 'stop', type: 'complete' } }
    : { ...message, role };
}

const EARLIER = [
  { message: textMessage('earlier-user', 'user', 'Earlier prompt'), parentId: null },
  { message: textMessage('earlier-reply', 'assistant', 'Earlier reply'), parentId: 'earlier-user' },
];

/**
 * What hydration returns once the cancel settled: the durable transcript plus
 * the rediscovered pause carrying its durable decision state
 * (`appendSuspendedPauseMessages`, `decisionState` from
 * `readDelegatedDecisionStates`).
 */
const AFTER_STOP = [
  ...EARLIER,
  {
    message: textMessage('stopped-user', 'user', 'Fan out the readers'),
    parentId: 'earlier-reply',
  },
  {
    message: {
      content: [
        {
          data: {
            ...LIVE_PAUSE,
            decisionState: 'cancelled',
            stale: false,
            suspendedAt: '2026-09-15T10:00:00.000Z',
          },
          name: TOOL_APPROVAL_DATA_NAME,
          type: 'data',
        },
      ],
      id: 'suspended-approval:root-run:delegate-1',
      role: 'assistant',
      status: { reason: 'stop', type: 'complete' },
    } satisfies ThreadMessageLike,
    parentId: 'stopped-user',
  },
];

function createHistorySource(): {
  readonly adapter: ThreadHistoryAdapter;
  readonly load: ReturnType<typeof vi.fn>;
  setDurable: (entries: readonly { message: ThreadMessageLike; parentId: string | null }[]) => void;
} {
  let durable: readonly { message: ThreadMessageLike; parentId: string | null }[] = EARLIER;
  const load = vi.fn(async () => {
    const entries = [...durable];
    const headId = entries.at(-1)?.message.id;
    return ExportedMessageRepository.fromBranchableArray(
      entries,
      headId ? { headId } : { headId: null }
    );
  });
  return {
    adapter: { append: vi.fn(async () => undefined), load },
    load,
    setDurable: (entries) => {
      durable = entries;
    },
  };
}

/** The live leg: the pause notice, then an open stream until Stop aborts it. */
function liveStreamResponse(signal: AbortSignal | null | undefined, pause: unknown): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (pause !== undefined) {
        controller.enqueue(
          encoder.encode(
            `aui-data:${JSON.stringify({ data: pause, name: TOOL_APPROVAL_DATA_NAME })}\n`
          )
        );
      }
      controller.enqueue(encoder.encode('0:"Dispatching the readers"\n'));
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(body, {
    headers: {
      [ASSISTANT_STREAM_EVENT_ID_HEADER]: 'session-1:0',
      [ASSISTANT_STREAM_MESSAGE_ID_HEADER]: 'assistant-live-1',
    },
    status: 200,
  });
}

function stubHost(pause: unknown): { readonly cancelBodies: unknown[] } {
  const cancelBodies: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === BASE && url.pathname === '/assistant' && init?.method === 'POST') {
        return liveStreamResponse(init.signal, pause);
      }
      if (url.origin === BASE && url.pathname === '/assistant/cancel') {
        cancelBodies.push(init?.body);
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${url.href}`);
    })
  );
  return { cancelBodies };
}

async function renderAndStartRun(
  history: ReturnType<typeof createHistorySource>,
  {
    completePreparedRequest = vi.fn(),
    onStopReread,
  }: {
    completePreparedRequest?: AssistantUiPanelProps['completePreparedRequest'];
    onStopReread?: () => void;
  } = {}
) {
  let runtime: PanelRuntime | undefined;
  render(
    <AssistantUiPanel
      completePreparedRequest={completePreparedRequest}
      historyAdapter={history.adapter}
      localChatTransport="data-stream"
      onRuntimeReady={(next) => {
        runtime = next;
      }}
      {...(onStopReread ? { onStopReread } : {})}
      pickerModels={[]}
      pickerProviders={[]}
      prepareRequestData={async () => ({
        memory: { resourceId: 'workspace-1', runId: RUN_ID, threadId: THREAD_KEY },
      })}
      threadKey={THREAD_KEY}
    />,
    { wrapper: PanelOwner }
  );
  await waitFor(() => expect(history.load).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryAllByTestId('markdown-text')).toHaveLength(2));
  // The desktop endpoint resolves asynchronously from the bridge; a run sent
  // before it resolves would post to the web default.
  await waitFor(() => expect(runtime).toBeDefined());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    runtime?.thread.append({
      content: [{ text: 'Fan out the readers', type: 'text' }],
      role: 'user',
    });
  });
}

describe('root Stop re-reads pauses from the host ledger', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    Object.assign(window, {
      assistant: { getAuth: vi.fn(async () => ({ token: 'desktop-token', url: BASE })) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'assistant');
  });

  it('drops a cancelled background pause from the strip and the card after a successful Stop', async () => {
    const user = userEvent.setup();
    const history = createHistorySource();
    const host = stubHost(LIVE_PAUSE);
    const onStopReread = vi.fn();
    await renderAndStartRun(history, { onStopReread });

    // The live leg published the root card: one pending read, counted at the composer.
    expect(await screen.findByTestId('approval-queue-strip')).toHaveTextContent(
      '1 approval waiting'
    );
    expect(screen.getByTestId('assistant-tool-approval-notice')).toHaveTextContent('Pending');

    // The host cancels the turn's paused work; rediscovery now reports it cancelled.
    history.setDurable(AFTER_STOP);
    await user.click(await screen.findByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(host.cancelBodies).toEqual([JSON.stringify({ runId: RUN_ID })]));
    await waitFor(() => expect(history.load).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByTestId('approval-queue-strip')).not.toBeInTheDocument()
    );
    expect(screen.getByTestId('approval-row-status')).toHaveTextContent('Turn cancelled');
    // The host is told once, so it can carry the live composer draft into the
    // mount that replaces this one.
    expect(onStopReread).toHaveBeenCalledTimes(1);
  });

  /**
   * The re-read is a remount, and a remount discards the live runtime's
   * composer draft (the child Stop reloads history in place and keeps it). A
   * Stop whose turn showed no undecided pause has nothing stale to re-read.
   */
  it('keeps the mounted thread when the stopped turn showed no undecided pause', async () => {
    const user = userEvent.setup();
    const history = createHistorySource();
    const completePreparedRequest = vi.fn();
    const onStopReread = vi.fn();
    const host = stubHost(undefined);
    await renderAndStartRun(history, { completePreparedRequest, onStopReread });

    await user.click(await screen.findByRole('button', { name: 'Stop' }));

    await waitFor(() =>
      expect(completePreparedRequest).toHaveBeenCalledWith(expect.any(Object), 'cancelled')
    );
    expect(host.cancelBodies).toEqual([JSON.stringify({ runId: RUN_ID })]);
    // Let the settled cancel's continuation and any remount it triggers run.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(history.load).toHaveBeenCalledTimes(1);
    expect(onStopReread).not.toHaveBeenCalled();
  });

  /**
   * The ordering half of the draft carry (owner ruling 2026-09-15). The host
   * (app-shell's thread-scoped command store) is told BEFORE the remount and
   * hands the draft back as a replace command; this proves the command reaches
   * the NEW mount rather than the composer that is about to be discarded.
   * `assistant-ui-panel-wrapper.test.tsx` proves the real store wiring.
   */
  it('keeps a draft typed before the Stop in the composer that replaces it', async () => {
    const user = userEvent.setup();
    const history = createHistorySource();
    const host = stubHost(LIVE_PAUSE);
    render(<DraftCarryHost history={history} />, { wrapper: PanelOwner });
    await waitFor(() => expect(history.load).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      startRun(screen.getByTestId('start-run'));
    });
    await screen.findByTestId('approval-queue-strip');

    const composer = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' });
    await user.type(composer, 'Read only the manifest');
    expect(composer).toHaveValue('Read only the manifest');

    history.setDurable(AFTER_STOP);
    await user.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(host.cancelBodies).toHaveLength(1));
    await waitFor(() => expect(history.load).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message input' })
      ).toHaveValue('Read only the manifest')
    );
  });
});

/**
 * The host half of the carry, exactly as app-shell wires it: it records the
 * live draft, and when the panel re-reads it hands that draft back as a
 * `replace` command for this thread, acknowledged once applied.
 */
function DraftCarryHost({ history }: { history: ReturnType<typeof createHistorySource> }) {
  const draft = useRef('');
  const [command, setCommand] = useState<ComposerDraftCommand | undefined>(undefined);
  const [runtime, setRuntime] = useState<PanelRuntime | undefined>(undefined);
  return (
    <>
      <button
        data-testid="start-run"
        onClick={() =>
          runtime?.thread.append({
            content: [{ text: 'Fan out the readers', type: 'text' }],
            role: 'user',
          })
        }
        type="button"
      >
        Start run
      </button>
      <AssistantUiPanel
        completePreparedRequest={vi.fn()}
        composerDraftCommand={command}
        historyAdapter={history.adapter}
        localChatTransport="data-stream"
        onComposerDraftCommandApplied={() => setCommand(undefined)}
        onComposerTextChange={(text) => {
          draft.current = text;
        }}
        onRuntimeReady={(next) => {
          setRuntime(next);
          return;
        }}
        onStopReread={() => {
          if (draft.current.trim() !== '') {
            setCommand({
              id: `draft-${draft.current.length}`,
              mode: 'replace',
              text: draft.current,
            });
          }
        }}
        pickerModels={[]}
        pickerProviders={[]}
        prepareRequestData={async () => ({
          memory: { resourceId: 'workspace-1', runId: RUN_ID, threadId: THREAD_KEY },
        })}
        threadKey={THREAD_KEY}
      />
    </>
  );
}

function startRun(button: HTMLElement): void {
  button.click();
}

function PanelOwner({ children }: PropsWithChildren) {
  return (
    <TooltipProvider>
      <RewindProvider value={{ requestRewind: () => undefined }}>{children}</RewindProvider>
    </TooltipProvider>
  );
}
