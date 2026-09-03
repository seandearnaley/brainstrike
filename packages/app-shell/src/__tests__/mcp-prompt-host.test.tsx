/**
 * BST-1592 — composer MCP prompt host: argument-less prompts stage straight
 * into the composer draft, argument-taking prompts collect values in the modal
 * with `completion/complete` suggestions, failures and non-text parts surface
 * visibly, and a server that retires mid-selection blocks submission instead of
 * silently retargeting another generation.
 */
import type { McpHostSnapshot } from '@brainstrike/assistant-contract';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastSpy = vi.fn();
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  useToast: () => ({ toast: toastSpy }),
}));

import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import { selectMcpPromptEntries } from '../mcp-prompts/mcp-prompt-catalog';
import { McpPromptComposerHost } from '../mcp-prompts/mcp-prompt-host';
import { useMcpPromptSelectionStore } from '../mcp-prompts/mcp-prompt-selection-store';

type StatusListener = (event: { revision: number; servers: unknown[] }) => void;
const listeners = new Set<StatusListener>();

function connectedServer(prompts: unknown[], generation = 7): unknown {
  return {
    catalog: {
      errors: {},
      features: {
        completion: true,
        promptListChanged: false,
        prompts: true,
        resourceListChanged: false,
        resourceSubscriptions: false,
        resources: false,
        toolListChanged: false,
      },
      prompts: { prompts },
      subscription: { mode: 'none', state: 'closed' },
    },
    configuredProtocol: '2026-07-28',
    configuredServerId: 'alpha',
    generation,
    negotiated: { revision: '2026-07-28' },
    state: 'connected',
    transport: 'streamable-http',
  };
}

function installBridge(
  prompts: unknown[],
  overrides: {
    complete?: ReturnType<typeof vi.fn>;
    getPrompt?: ReturnType<typeof vi.fn>;
  } = {}
) {
  const servers = [connectedServer(prompts)];
  const bridge = {
    complete:
      overrides.complete ??
      vi.fn(async () => ({
        result: { completion: { hasMore: false, total: 0, values: [] } },
        type: 'completion/complete',
      })),
    getPrompt:
      overrides.getPrompt ??
      vi.fn(async () => ({
        result: { messages: [{ content: { text: 'Staged body.', type: 'text' }, role: 'user' }] },
        type: 'prompts/get',
      })),
    getServerStatusSnapshot: vi.fn(
      async () => ({ revision: 1, servers }) as unknown as McpHostSnapshot
    ),
    onServerStatusUpdated: (listener: StatusListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  (window as unknown as { mcp?: unknown }).mcp = bridge;
  return bridge;
}

/**
 * Select a prompt the way the "/" menu does, with the composer draft in the
 * state the pinned popover leaves it in: it strips the trigger with
 * `setText(before + (after.startsWith(' ') ? after.slice(1) : after))` before
 * `execute` runs, and the app records that. So `'draft /mcp:alpha:review tail'`
 * is captured and `'draft tail'` is live — an UNTOUCHED draft.
 */
function select(prompts: unknown[], index = 0): void {
  const entry = selectMcpPromptEntries({
    revision: 1,
    servers: [connectedServer(prompts)],
  } as unknown as McpHostSnapshot)[index];
  if (!entry) {
    throw new Error('test prompt entry is missing');
  }
  useAssistantComposerCommandStore.getState().recordDraft('thread-1', 'draft tail');
  useMcpPromptSelectionStore.getState().select({
    draftText: `draft /${entry.commandId} tail`,
    entry,
    split: { prefix: 'draft ', suffix: ' tail' },
    threadId: 'thread-1',
  });
}

function stagedCommand() {
  return useAssistantComposerCommandStore.getState().commandsByThreadId['thread-1']?.[0];
}

/** A `getPrompt` the test resolves by hand, so the round trip stays in flight. */
function deferredGetPrompt(text = 'Staged body.') {
  let release: (() => void) | undefined;
  const getPrompt = vi.fn(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            result: { messages: [{ content: { text, type: 'text' }, role: 'user' }] },
            type: 'prompts/get',
          });
      })
  );
  return {
    getPrompt,
    release: (): void => {
      if (!release) {
        throw new Error('prompts/get was never called');
      }
      release();
    },
  };
}

function stagedText(): string | undefined {
  return useAssistantComposerCommandStore.getState().commandsByThreadId['thread-1']?.[0]?.text;
}

beforeEach(() => {
  useAssistantComposerCommandStore.getState().reset();
  useMcpPromptSelectionStore.getState().clear();
  listeners.clear();
  toastSpy.mockClear();
});

afterEach(() => {
  (window as unknown as { mcp?: unknown }).mcp = undefined;
  vi.restoreAllMocks();
});

describe('McpPromptComposerHost', () => {
  it('renders nothing without the desktop bridge', () => {
    const { container } = render(<McpPromptComposerHost />);
    expect(container).toBeEmptyDOMElement();
  });

  it('stages an argument-less prompt into the composer draft without a dialog', async () => {
    const prompts = [{ name: 'review' }];
    const bridge = installBridge(prompts);
    render(<McpPromptComposerHost />);

    act(() => select(prompts));

    await waitFor(() => expect(stagedText()).toBe('draft Staged body. tail'));
    expect(bridge.getPrompt).toHaveBeenCalledWith({
      authority: { configuredServerId: 'alpha', generation: 7 },
      name: 'review',
    });
    expect(screen.queryByTestId('mcp-prompt-dialog')).toBeNull();
    expect(useMcpPromptSelectionStore.getState().selection).toBeNull();
  });

  it('reports parts that cannot be staged instead of dropping them silently', async () => {
    const prompts = [{ name: 'review' }];
    installBridge(prompts, {
      getPrompt: vi.fn(async () => ({
        result: {
          messages: [
            { content: { data: 'AAA', mimeType: 'image/png', type: 'image' }, role: 'user' },
            { content: { text: 'Describe it.', type: 'text' }, role: 'user' },
          ],
        },
        type: 'prompts/get',
      })),
    });
    render(<McpPromptComposerHost />);

    act(() => select(prompts));

    await waitFor(() => expect(stagedText()).toBe('draft Describe it. tail'));
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('message 1 (user): image content'),
        title: 'Prompt partially staged',
      })
    );
  });

  it('surfaces a failed prompts/get as a destructive toast and stages nothing', async () => {
    const prompts = [{ name: 'review' }];
    installBridge(prompts, {
      getPrompt: vi.fn(async () => {
        throw new Error('MCP content server not connected (not-connected · x)');
      }),
    });
    render(<McpPromptComposerHost />);

    act(() => select(prompts));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'MCP content server not connected (not-connected · x)',
          title: 'MCP prompt failed',
          variant: 'destructive',
        })
      )
    );
    expect(stagedText()).toBeUndefined();
  });

  it('collects arguments in the dialog, autocompletes them, and stages on submit', async () => {
    const user = userEvent.setup();
    const prompts = [{ arguments: [{ name: 'path', required: true }], name: 'review' }];
    const complete = vi.fn(async () => ({
      result: { completion: { hasMore: false, total: 2, values: ['src/a.ts', 'src/a.ts'] } },
      type: 'completion/complete' as const,
    }));
    const bridge = installBridge(prompts, { complete });
    render(<McpPromptComposerHost />);

    act(() => select(prompts));
    const dialog = await screen.findByTestId('mcp-prompt-dialog');
    expect(dialog).toHaveTextContent('Insert prompt “review”');
    expect(dialog).toHaveTextContent('configured MCP server “alpha”');

    await user.type(screen.getByLabelText(/path/u), 'src/');
    // One 250 ms debounced round trip per pause, not one per keystroke.
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(complete).toHaveBeenCalledWith({
      argument: { name: 'path', value: 'src/' },
      authority: { configuredServerId: 'alpha', generation: 7 },
      ref: { name: 'review', type: 'ref/prompt' },
    });
    // Duplicate suggestion values collapse into one option.
    await waitFor(() => expect(document.querySelectorAll('datalist option')).toHaveLength(1));

    await user.click(screen.getByRole('button', { name: 'Insert prompt' }));
    await waitFor(() => expect(stagedText()).toBe('draft Staged body. tail'));
    expect(bridge.getPrompt).toHaveBeenCalledWith({
      arguments: { path: 'src/' },
      authority: { configuredServerId: 'alpha', generation: 7 },
      name: 'review',
    });
  });

  it('refuses to submit a required argument left empty', async () => {
    const user = userEvent.setup();
    const prompts = [{ arguments: [{ name: 'path', required: true }], name: 'review' }];
    const bridge = installBridge(prompts);
    render(<McpPromptComposerHost />);

    act(() => select(prompts));
    await screen.findByTestId('mcp-prompt-dialog');
    await user.click(screen.getByRole('button', { name: 'Insert prompt' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Prompt argument path is required');
    expect(bridge.getPrompt).not.toHaveBeenCalled();
  });

  it('blocks submission visibly when the server retires mid-selection', async () => {
    const prompts = [{ arguments: [{ name: 'path', required: true }], name: 'review' }];
    installBridge(prompts);
    render(<McpPromptComposerHost />);

    act(() => select(prompts));
    await screen.findByTestId('mcp-prompt-dialog');

    act(() => {
      for (const listener of listeners) {
        listener({ revision: 2, servers: [] });
      }
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('no longer connected');
    expect(screen.getByRole('button', { name: 'Insert prompt' })).toBeDisabled();
  });
  it('surfaces a malformed desktop bridge instead of vanishing like web', async () => {
    // Some but not all content members: a packaging defect, not an unsupported
    // runtime. Without this the user watches the capability disappear with the
    // same empty surface web shows, and no actionable error.
    (window as unknown as { mcp?: unknown }).mcp = { getPrompt: vi.fn() };

    const { container } = render(<McpPromptComposerHost />);

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          description: expect.stringContaining('complete'),
          title: 'MCP prompts unavailable',
          variant: 'destructive',
        })
      )
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('says nothing when the runtime legitimately has no prompt bridge', async () => {
    (window as unknown as { mcp?: unknown }).mcp = { listServers: vi.fn() };

    render(<McpPromptComposerHost />);

    await waitFor(() => expect(toastSpy).not.toHaveBeenCalled());
  });

  it('stages nothing when the dialog is dismissed while prompts/get is in flight', async () => {
    const user = userEvent.setup();
    const prompts = [{ arguments: [{ name: 'path' }], name: 'review' }];
    const deferred = deferredGetPrompt();
    installBridge(prompts, { getPrompt: deferred.getPrompt });
    render(<McpPromptComposerHost />);

    act(() => select(prompts));
    await screen.findByTestId('mcp-prompt-dialog');
    await user.click(screen.getByRole('button', { name: 'Insert prompt' }));
    await waitFor(() => expect(deferred.getPrompt).toHaveBeenCalledTimes(1));

    // Escape is deliberately still available mid-request (the footer's Cancel
    // button is not) — the abort has to be honoured after the await instead.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(useMcpPromptSelectionStore.getState().selection).toBeNull());
    await act(async () => {
      deferred.release();
      await Promise.resolve();
    });

    expect(stagedText()).toBeUndefined();
  });

  it('appends instead of overwriting a draft the user changed while the prompt loaded', async () => {
    const prompts = [{ name: 'review' }];
    const deferred = deferredGetPrompt();
    installBridge(prompts, { getPrompt: deferred.getPrompt });
    render(<McpPromptComposerHost />);

    act(() => select(prompts));
    await waitFor(() => expect(deferred.getPrompt).toHaveBeenCalledTimes(1));

    // The composer stays editable across the round trip.
    act(() => {
      useAssistantComposerCommandStore.getState().recordDraft('thread-1', 'draft tail and more');
    });
    await act(async () => {
      deferred.release();
      await Promise.resolve();
    });

    // `replace` with the selection-time split would have discarded "and more".
    await waitFor(() =>
      expect(stagedCommand()).toMatchObject({ mode: 'append', text: 'Staged body.' })
    );
  });

  it('appends into the fresh draft when the message was sent while the prompt loaded', async () => {
    const prompts = [{ name: 'review' }];
    const deferred = deferredGetPrompt();
    installBridge(prompts, { getPrompt: deferred.getPrompt });
    render(<McpPromptComposerHost />);

    act(() => select(prompts));
    await waitFor(() => expect(deferred.getPrompt).toHaveBeenCalledTimes(1));

    act(() => {
      useAssistantComposerCommandStore.getState().recordDraft('thread-1', '');
    });
    await act(async () => {
      deferred.release();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(stagedCommand()).toMatchObject({ mode: 'append', text: 'Staged body.' })
    );
  });
});
