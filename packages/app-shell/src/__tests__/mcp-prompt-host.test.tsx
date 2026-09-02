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

function select(prompts: unknown[], index = 0): void {
  const entry = selectMcpPromptEntries({
    revision: 1,
    servers: [connectedServer(prompts)],
  } as unknown as McpHostSnapshot)[index];
  if (!entry) {
    throw new Error('test prompt entry is missing');
  }
  useMcpPromptSelectionStore
    .getState()
    .select({ entry, split: { prefix: 'draft ', suffix: ' tail' }, threadId: 'thread-1' });
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
});
