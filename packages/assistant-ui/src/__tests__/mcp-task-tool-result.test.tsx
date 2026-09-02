import type { McpTaskBridge, McpTaskStatusChangedEvent } from '@brainstrike/assistant-contract';
import type { McpTaskPresentation } from '@brainstrike/assistant-contract/mcp-task-presentation';
import { TooltipProvider } from '@brainstrike/ui';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { McpTaskBridgeProvider } from '../mcp-task-bridge-context';
import { McpTaskToolResult } from '../mcp-task-tool-result';
import { CHAIN_OF_THOUGHT_TOOL_COMPONENTS } from '../todo-progress';

const HANDLE = {
  authorityEpoch: '00000000-0000-7000-8000-000000000000',
  principalId: 'principal-secret',
  resource: 'https://tasks.example.test/private',
  serverId: 'server-secret',
  taskId: 'task-secret',
} as const;

function task(overrides: Partial<McpTaskPresentation> = {}): McpTaskPresentation {
  return {
    canCancel: true,
    createdAt: '2026-09-01T05:00:00.000Z',
    handle: HANDLE,
    history: [{ at: '2026-09-01T05:00:00.000Z', status: 'working' }],
    omittedHistoryEntries: 0,
    recovery: 'live',
    status: 'working',
    statusMessage: 'Persisted snapshot',
    updatedAt: '2026-09-01T05:00:00.000Z',
    ...overrides,
  };
}

interface BridgeHarness {
  readonly bridge: McpTaskBridge;
  readonly emit: (event: McpTaskStatusChangedEvent) => void;
  readonly listeners: Set<(event: McpTaskStatusChangedEvent) => void>;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
}

function bridgeHarness(listed: readonly McpTaskPresentation[]): BridgeHarness {
  const listeners = new Set<(event: McpTaskStatusChangedEvent) => void>();
  const unsubscribe = vi.fn();
  const bridge: McpTaskBridge = {
    act: vi.fn<McpTaskBridge['act']>().mockImplementation(async ({ handle }) => ({
      ok: true,
      task: task({ handle, status: 'cancelled', updatedAt: '2026-09-01T05:00:09.000Z' }),
    })),
    list: vi.fn<McpTaskBridge['list']>().mockResolvedValue({ tasks: [...listed] }),
    onStatusChanged: vi.fn<McpTaskBridge['onStatusChanged']>().mockImplementation((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    }),
  };
  return {
    bridge,
    emit: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    listeners,
    unsubscribe,
  };
}

function renderWithBridge(bridge: McpTaskBridge | null, snapshot = task()) {
  return render(
    <McpTaskBridgeProvider bridge={bridge}>
      <McpTaskToolResult snapshot={snapshot} />
    </McpTaskBridgeProvider>
  );
}

const summary = () => screen.getByTestId('mcp-task-status-summary');

describe('McpTaskToolResult', () => {
  it('renders the persisted snapshot statically with an explicit unavailable note when no bridge exists', () => {
    render(<McpTaskToolResult snapshot={task()} />);

    expect(summary()).toHaveTextContent('Working');
    expect(screen.getByText('Persisted snapshot')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-task-live-status-note')).toHaveTextContent(
      /live status unavailable/i
    );
  });

  it('surfaces a visible diagnostic instead of acting when no bridge exists', async () => {
    render(<McpTaskToolResult snapshot={task()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel task' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/unavailable/i);
    expect(summary()).toHaveTextContent('Working');
  });

  it('adopts the live presentation for the same handle from list() on mount', async () => {
    const harness = bridgeHarness([
      task({ handle: { ...HANDLE, taskId: 'other' }, status: 'failed' }),
      task({
        status: 'input_required',
        statusMessage: 'Live from main',
        updatedAt: '2026-09-01T05:00:05.000Z',
      }),
    ]);
    renderWithBridge(harness.bridge);

    await waitFor(() => expect(summary()).toHaveTextContent('Input required'));
    expect(screen.getByText('Live from main')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-task-live-status-note')).not.toBeInTheDocument();
    expect(harness.bridge.list).toHaveBeenCalledTimes(1);
  });

  it('applies onStatusChanged updates for the same handle only, and never a stale one', async () => {
    const harness = bridgeHarness([]);
    renderWithBridge(harness.bridge);
    await waitFor(() => expect(harness.listeners.size).toBe(1));

    act(() => {
      harness.emit({
        task: task({
          handle: { ...HANDLE, authorityEpoch: '00000000-0000-7000-8000-000000000001' },
          status: 'failed',
          updatedAt: '2026-09-01T05:00:08.000Z',
        }),
      });
    });
    expect(summary()).toHaveTextContent('Working');

    act(() => {
      harness.emit({
        task: task({ status: 'completed', updatedAt: '2026-09-01T05:00:06.000Z' }),
      });
    });
    expect(summary()).toHaveTextContent('Completed');

    act(() => {
      harness.emit({
        task: task({ status: 'failed', updatedAt: '2026-09-01T05:00:03.000Z' }),
      });
    });
    expect(summary()).toHaveTextContent('Completed');
  });

  it('forwards cancel through bridge.act with the exact handle and adopts the observed state', async () => {
    const harness = bridgeHarness([]);
    renderWithBridge(harness.bridge);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel task' }));

    expect(harness.bridge.act).toHaveBeenCalledWith({ action: 'cancel', handle: HANDLE });
    await waitFor(() => expect(summary()).toHaveTextContent('Cancelled'));
  });

  it('forwards recover through bridge.act', async () => {
    const harness = bridgeHarness([]);
    renderWithBridge(harness.bridge, task({ recovery: 'restart_required' }));

    await userEvent.click(screen.getByRole('button', { name: 'Recover task' }));

    expect(harness.bridge.act).toHaveBeenCalledWith({ action: 'recover', handle: HANDLE });
  });

  it('unsubscribes from status changes on unmount', async () => {
    const harness = bridgeHarness([]);
    const view = renderWithBridge(harness.bridge);
    await waitFor(() => expect(harness.listeners.size).toBe(1));

    view.unmount();

    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
    expect(harness.listeners.size).toBe(0);
  });

  it('shows a visible failure note when list() rejects, keeping the snapshot', async () => {
    const harness = bridgeHarness([]);
    vi.mocked(harness.bridge.list).mockRejectedValueOnce(new Error('ipc down'));
    renderWithBridge(harness.bridge);

    expect(await screen.findByTestId('mcp-task-live-status-note')).toHaveTextContent(
      /could not be loaded/i
    );
    expect(summary()).toHaveTextContent('Working');
  });
});

describe('CHAIN_OF_THOUGHT_TOOL_COMPONENTS.Fallback routing', () => {
  beforeAll(() => {
    global.ResizeObserver = class {
      disconnect() {}
      observe() {}
      unobserve() {}
    } as never;
    window.HTMLElement.prototype.scrollIntoView = () => {};
  });

  function renderFallback(props: Record<string, unknown>) {
    const Fallback = CHAIN_OF_THOUGHT_TOOL_COMPONENTS.Fallback as unknown as (
      p: Record<string, unknown>
    ) => ReactElement;
    return render(
      <TooltipProvider>
        <Fallback {...props} />
      </TooltipProvider>
    );
  }

  it('routes a persisted mcp-task marker result to the status card regardless of tool name', () => {
    renderFallback({
      argsText: '{}',
      result: { kind: 'mcp-task', task: task() },
      status: { type: 'complete' },
      toolName: 'server-defined-tool-name',
    });

    expect(screen.getByTestId('mcp-task-status-card')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-fallback')).not.toBeInTheDocument();
  });

  it('keeps ordinary tool results on ToolFallback', () => {
    renderFallback({
      argsText: '{}',
      result: { kind: 'mcp-task' },
      status: { type: 'complete' },
      toolName: 'server-defined-tool-name',
    });

    expect(screen.getByTestId('tool-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-task-status-card')).not.toBeInTheDocument();
  });
});
