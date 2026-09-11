import type { PropsWithChildren } from 'react';
import { RewindProvider } from '../rewind-context';
/**
 * `historyGeneration` — the re-hydration seam Conversation Rewind needs
 * (BST-1115).
 *
 * A rewind's whole effect is durable: tombstone rows the history query already
 * excludes, and files on disk. But `ThreadHistoryAdapter.load()` runs ONCE per
 * runtime mount, so a rewind applied while the thread is on screen changed
 * nothing the user could see — the messages it hid stayed rendered until the
 * user switched threads or restarted the app. This proves the panel re-reads
 * history when the generation moves, that a redo re-reads it again, and that
 * the per-thread state a rewind must NOT destroy survives the remount.
 *
 * Real `AssistantUiPanel`, real history adapter; only the data-stream runtime
 * is swapped for a local one (same substitution as
 * `history-hydration-composer.behavior.test.tsx`).
 */
import '@testing-library/jest-dom/vitest';
import {
  type ChatModelAdapter,
  ExportedMessageRepository,
  type ThreadHistoryAdapter,
  type ThreadMessageLike,
  useLocalRuntime,
} from '@assistant-ui/react';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const run = vi.fn(async function* () {
  yield { content: [] };
});
const NOOP_ADAPTER: ChatModelAdapter = { run };

vi.mock('../data-stream-runtime', () => ({
  useBrainstrikeDataStreamRuntime: (options: {
    adapters?: NonNullable<Parameters<typeof useLocalRuntime>[1]>['adapters'];
  }) => useLocalRuntime(NOOP_ADAPTER, { adapters: options.adapters }),
}));
// The real text components read their content from assistant-ui's part
// context and take no props, so they cannot render an assertable string here.
// The COUNT of rendered message bodies is the observable: it is exactly how
// many messages hydration returned.
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

import { AssistantUiPanel } from '../assistant-ui-panel';
import { useRewindComposerStore } from '../rewind-composer-store';

const THREAD_KEY = 'thread-rewind-generation';

function textMessage(id: string, role: 'assistant' | 'user', text: string): ThreadMessageLike {
  const message = { content: [{ text, type: 'text' }] as const, id };
  return role === 'assistant'
    ? { ...message, role, status: { reason: 'stop', type: 'complete' } }
    : { ...message, role };
}

/** The full thread, before any rewind. `kept` is what a rewind to `hidden-1`
 * leaves visible — exactly what the tombstone-filtered hydration query returns. */
const FULL = [
  { message: textMessage('kept-1', 'user', 'Kept prompt'), parentId: null },
  { message: textMessage('kept-2', 'assistant', 'Kept reply'), parentId: 'kept-1' },
  { message: textMessage('hidden-1', 'user', 'Rewound prompt'), parentId: 'kept-2' },
  { message: textMessage('hidden-2', 'assistant', 'Rewound reply'), parentId: 'hidden-1' },
] as const;

const KEPT = FULL.slice(0, 2);

/** One rendered body per hydrated message — see the text-component mock. */
function renderedMessageCount(): number {
  return screen.queryAllByTestId('markdown-text').length;
}

async function waitForMessageCount(count: number): Promise<void> {
  await waitFor(() => expect(renderedMessageCount()).toBe(count));
}

/**
 * History adapter over a MUTABLE source, which is what makes this a real
 * re-read test rather than a prop test: the panel can only show the narrowed
 * thread if it calls `load()` again AFTER the source changed.
 */
function createHistoryAdapter(): {
  readonly adapter: ThreadHistoryAdapter;
  readonly load: ReturnType<typeof vi.fn>;
  setVisible: (entries: readonly (typeof FULL)[number][]) => void;
} {
  let visible: readonly (typeof FULL)[number][] = FULL;
  const load = vi.fn(async () => {
    const entries = [...visible];
    const headId = entries.at(-1)?.message.id;
    return ExportedMessageRepository.fromBranchableArray(
      entries,
      headId ? { headId } : { headId: null }
    );
  });
  return {
    adapter: { append: vi.fn(async () => undefined), load },
    load,
    setVisible: (entries) => {
      visible = entries;
    },
  };
}

describe('AssistantUiPanel — historyGeneration re-hydration', () => {
  it('re-reads history when a rewind applies, and again when it is undone', async () => {
    const history = createHistoryAdapter();
    const { rerender } = render(
      <AssistantUiPanel
        historyAdapter={history.adapter}
        historyGeneration={0}
        localChatTransport="data-stream"
        pickerModels={[]}
        pickerProviders={[]}
        threadKey={THREAD_KEY}
      />,
      { wrapper: RewindOwner }
    );

    await waitForMessageCount(FULL.length);
    expect(history.load).toHaveBeenCalledTimes(1);

    // The rewind: the tombstoned messages leave the query's result set, and the
    // generation moves. Without the generation in the runtime key this rerender
    // changes nothing on screen — which was the reported defect.
    history.setVisible(KEPT);
    rerender(
      <AssistantUiPanel
        historyAdapter={history.adapter}
        historyGeneration={1}
        localChatTransport="data-stream"
        pickerModels={[]}
        pickerProviders={[]}
        threadKey={THREAD_KEY}
      />
    );

    await waitForMessageCount(KEPT.length);
    expect(history.load).toHaveBeenCalledTimes(2);

    // The redo: the batch is deleted, the messages are visible again, and the
    // same counter moves again. Redo is not a special case, it is another bump.
    history.setVisible(FULL);
    rerender(
      <AssistantUiPanel
        historyAdapter={history.adapter}
        historyGeneration={2}
        localChatTransport="data-stream"
        pickerModels={[]}
        pickerProviders={[]}
        threadKey={THREAD_KEY}
      />
    );

    await waitForMessageCount(FULL.length);
    expect(history.load).toHaveBeenCalledTimes(3);
  });

  /**
   * The other half of the seam's contract. The generation must move ONLY for a
   * durable change, because a remount is destructive: it discards the live
   * thread's in-memory state, which is right after a rewind and wrong for any
   * ordinary re-render.
   */
  it('does not re-read history when nothing rewound', async () => {
    const history = createHistoryAdapter();
    const { rerender } = render(
      <AssistantUiPanel
        historyAdapter={history.adapter}
        historyGeneration={0}
        localChatTransport="data-stream"
        pickerModels={[]}
        pickerProviders={[]}
        threadKey={THREAD_KEY}
      />,
      { wrapper: RewindOwner }
    );
    await waitForMessageCount(FULL.length);

    // A plain re-render (any unrelated prop change) must NOT throw away the
    // live thread: the remount is reserved for a durable change.
    rerender(
      <AssistantUiPanel
        disabledReason="anything unrelated"
        historyAdapter={history.adapter}
        historyGeneration={0}
        localChatTransport="data-stream"
        pickerModels={[]}
        pickerProviders={[]}
        threadKey={THREAD_KEY}
      />
    );

    await waitForMessageCount(FULL.length);
    expect(history.load).toHaveBeenCalledTimes(1);
  });

  /**
   * Amendment 2's rewind-and-retry loop crosses the remount: the confirm modal
   * bumps the generation and THEN hands the target prompt to the composer
   * store. `RewindComposerBridge` lives inside the runtime, so it is the
   * REMOUNTED instance that drains it — which is why the bump has to come
   * first, and why this is the per-thread state most worth pinning.
   */
  it('keeps the composer text a rewind restores across the remount', async () => {
    const history = createHistoryAdapter();
    const { rerender } = render(
      <AssistantUiPanel
        historyAdapter={history.adapter}
        historyGeneration={0}
        localChatTransport="data-stream"
        pickerModels={[]}
        pickerProviders={[]}
        threadKey={THREAD_KEY}
      />,
      { wrapper: RewindOwner }
    );
    await waitForMessageCount(FULL.length);

    history.setVisible(KEPT);
    useRewindComposerStore.getState().requestComposerText('Rewound prompt');
    rerender(
      <AssistantUiPanel
        historyAdapter={history.adapter}
        historyGeneration={1}
        localChatTransport="data-stream"
        pickerModels={[]}
        pickerProviders={[]}
        threadKey={THREAD_KEY}
      />
    );

    const input = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message input',
    });
    await waitFor(() => expect(input.value).toBe('Rewound prompt'));
    expect(useRewindComposerStore.getState().pendingText).toBeNull();
  });
});

function RewindOwner({ children }: PropsWithChildren) {
  return (
    <TooltipProvider>
      <RewindProvider value={{ requestRewind: () => undefined }}>{children}</RewindProvider>
    </TooltipProvider>
  );
}
