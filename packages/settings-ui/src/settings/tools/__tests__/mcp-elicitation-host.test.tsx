import '@testing-library/jest-dom/vitest';
import {
  type McpElicitationPresentationWire,
  type McpElicitationRetiredWire,
  type McpElicitationSettlement,
  type McpTaskActionResult,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpElicitationBridge } from '../mcp-elicitation-bridge';
import { McpElicitationHost } from '../mcp-elicitation-host';

const SERVER_ID = parseConfiguredMcpServerId('team.linear.prod');
const TASK_HANDLE = {
  authorityEpoch: '00000000-0000-4000-8000-000000000001',
  principalId: 'fixture-principal',
  resource: 'https://tasks.example.test/',
  serverId: SERVER_ID,
  taskId: 'pending-task',
};
const presentation = (id: string): McpElicitationPresentationWire => ({
  id,
  message: `Message ${id}`,
  mode: 'form',
  provenance: {
    configuredProtocol: '2026-07-28',
    configuredServerId: SERVER_ID,
    generation: 7,
    invocationId: 'nonce:1',
    negotiatedRevision: '2026-07-28',
    operation: { type: 'tools/list' },
    requestId: `request-${id}`,
    transport: 'streamable-http',
  },
  requestedSchema: { properties: {}, type: 'object' },
});
type TestWindow = Window & { mcp?: Partial<McpElicitationBridge> | undefined };
const testWindow = window as TestWindow;

function installBridge() {
  let requested: ((value: McpElicitationPresentationWire) => void) | undefined;
  let retired: ((value: McpElicitationRetiredWire) => void) | undefined;
  const disposeRequested = vi.fn();
  const disposeRetired = vi.fn();
  const bridge = {
    onElicitationRequested: vi.fn((callback: (value: McpElicitationPresentationWire) => void) => {
      requested = callback;
      return disposeRequested;
    }),
    onElicitationRetired: vi.fn((callback: (value: McpElicitationRetiredWire) => void) => {
      retired = callback;
      return disposeRetired;
    }),
    settleElicitation: vi.fn(async (_settlement: McpElicitationSettlement) => undefined),
  };
  testWindow.mcp = bridge;
  return {
    bridge,
    disposeRequested,
    disposeRetired,
    request: (value: McpElicitationPresentationWire) => act(() => requested?.(value)),
    retire: (value: McpElicitationRetiredWire) => act(() => retired?.(value)),
  };
}

afterEach(() => {
  testWindow.mcp = undefined;
  vi.restoreAllMocks();
});

describe('McpElicitationHost', () => {
  it('cancels the host-bound task inside its input modal and waits for observed cancellation', async () => {
    const user = userEvent.setup();
    const harness = installBridge();
    const handle = TASK_HANDLE;
    const cancellation = Promise.withResolvers<McpTaskActionResult>();
    const actTask = vi.fn(() => cancellation.promise);
    Object.assign(harness.bridge, {
      tasks: { act: actTask, list: vi.fn(), onStatusChanged: vi.fn() },
    });
    render(<McpElicitationHost />);
    const request = presentation('pending');
    harness.request({ ...request, provenance: { ...request.provenance, taskHandle: handle } });
    await user.click(await screen.findByRole('button', { name: 'Cancel task' }));
    await user.dblClick(screen.getByRole('button', { name: 'Cancelling task…' }));
    expect(actTask).toHaveBeenCalledExactlyOnceWith({ action: 'cancel', handle });
    expect(harness.bridge.settleElicitation).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Accept/u })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Decline/u })).toBeDisabled();
    harness.retire({ code: 'mcp-elicitation-caller-aborted', id: 'pending' });
    expect(screen.getByText(/no answer can be sent/u)).toBeInTheDocument();
    expect(screen.queryByText('Task cancelled.')).not.toBeInTheDocument();
    cancellation.resolve({
      ok: true,
      task: {
        canCancel: false,
        createdAt: '2026-10-03T00:00:00.000Z',
        handle,
        history: [],
        omittedHistoryEntries: 0,
        recovery: 'terminal',
        status: 'cancelled',
        statusMessage: null,
        updatedAt: '2026-10-03T00:00:01.000Z',
      },
    });
    await screen.findByText('Task cancelled.');
    expect(screen.queryByRole('button', { name: /^Accept|^Decline/u })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Dismiss/u }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(harness.bridge.settleElicitation).not.toHaveBeenCalled();
  });

  it('shows cancellation failure, permits retry, and refuses a non-cancelled outcome', async () => {
    const user = userEvent.setup();
    const harness = installBridge();
    const actTask = vi
      .fn()
      .mockResolvedValueOnce({
        diagnostic: { code: 'stale_handle', message: 'The task handle is stale.' },
        ok: false,
      })
      .mockResolvedValueOnce({ ok: true, task: { status: 'completed' } });
    Object.assign(harness.bridge, {
      tasks: { act: actTask, list: vi.fn(), onStatusChanged: vi.fn() },
    });
    render(<McpElicitationHost />);
    const request = presentation('pending');
    harness.request({ ...request, provenance: { ...request.provenance, taskHandle: TASK_HANDLE } });
    await user.click(await screen.findByRole('button', { name: 'Cancel task' }));
    await screen.findByText('The task handle is stale.');
    expect(screen.getByRole('button', { name: 'Cancel task' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Accept/u })).toBeEnabled();
    harness.retire({ code: 'mcp-elicitation-caller-aborted', id: 'pending' });
    await user.click(screen.getByRole('button', { name: 'Cancel task' }));
    await screen.findByText('MCP task cancellation did not observe a cancelled task.');
    expect(screen.queryByText('Task cancelled.')).not.toBeInTheDocument();
    expect(actTask).toHaveBeenCalledTimes(2);
    expect(harness.bridge.settleElicitation).not.toHaveBeenCalled();
  });

  it('visibly refuses task cancellation without the complete task capability', async () => {
    const harness = installBridge();
    render(<McpElicitationHost />);
    const request = presentation('pending');
    harness.request({ ...request, provenance: { ...request.provenance, taskHandle: TASK_HANDLE } });
    await screen.findByText('Task cancellation is unavailable in this window.');
    expect(screen.queryByRole('button', { name: 'Cancel task' })).not.toBeInTheDocument();
    expect(harness.bridge.settleElicitation).not.toHaveBeenCalled();
  });

  it('renders nothing and subscribes to nothing without a complete bridge', () => {
    const { container } = render(<McpElicitationHost />);
    expect(container).toBeEmptyDOMElement();

    testWindow.mcp = { onElicitationRequested: vi.fn(() => vi.fn()) };
    const partial = render(<McpElicitationHost />);
    expect(partial.container).toBeEmptyDOMElement();
    expect(testWindow.mcp.onElicitationRequested).not.toHaveBeenCalled();
  });

  it('registers both listeners and disposes them on unmount', () => {
    const harness = installBridge();
    const view = render(<McpElicitationHost />);
    expect(harness.bridge.onElicitationRequested).toHaveBeenCalledWith(expect.any(Function));
    expect(harness.bridge.onElicitationRetired).toHaveBeenCalledWith(expect.any(Function));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.unmount();
    expect(harness.disposeRequested).toHaveBeenCalledOnce();
    expect(harness.disposeRetired).toHaveBeenCalledOnce();
  });

  it('shows one presentation at a time, oldest first, and settles through the bridge', async () => {
    const user = userEvent.setup();
    const harness = installBridge();
    render(<McpElicitationHost />);
    harness.request(presentation('first'));
    harness.request(presentation('second'));
    harness.request(presentation('first'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Message first')).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    await user.click(within(dialog).getByRole('button', { name: /^Decline/u }));
    expect(harness.bridge.settleElicitation).toHaveBeenCalledWith({
      action: 'decline',
      configuredServerId: SERVER_ID,
      generation: 7,
      id: 'first',
      requestId: 'request-first',
    });
    // Main reports the settled finalization before the invoke resolves; that
    // must not flip the dialog into the retired state.
    harness.retire({ code: 'mcp-elicitation-already-settled', id: 'first' });
    await waitFor(() =>
      expect(within(screen.getByRole('dialog')).getByText('Message second')).toBeInTheDocument()
    );
    expect(screen.queryByText(/no longer pending/u)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Accept/u }));
    expect(harness.bridge.settleElicitation).toHaveBeenLastCalledWith({
      action: 'accept',
      configuredServerId: SERVER_ID,
      content: {},
      generation: 7,
      id: 'second',
      requestId: 'request-second',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('marks the visible request retired, drops unseen retired requests, and keeps failed settlements open', async () => {
    const user = userEvent.setup();
    const harness = installBridge();
    render(<McpElicitationHost />);
    harness.request(presentation('visible'));
    harness.request(presentation('queued'));
    harness.request(presentation('later'));
    await screen.findByRole('dialog');

    harness.retire({ code: 'mcp-elicitation-authority-retired', id: 'queued' });
    harness.retire({ code: 'mcp-elicitation-stale-authority', id: 'visible' });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('mcp-elicitation-stale-authority');
    await user.click(within(dialog).getByRole('button', { name: /^Dismiss/u }));
    await waitFor(() =>
      expect(within(screen.getByRole('dialog')).getByText('Message later')).toBeInTheDocument()
    );
    expect(harness.bridge.settleElicitation).not.toHaveBeenCalled();

    harness.bridge.settleElicitation.mockRejectedValueOnce(
      new Error('MCP elicitation settlement failed: mcp-elicitation-settlement-invalid')
    );
    await user.click(screen.getByRole('button', { name: /^Cancel/u }));
    expect(
      await within(screen.getByRole('dialog')).findByText(
        'MCP elicitation settlement failed: mcp-elicitation-settlement-invalid'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Cancel/u })).toBeEnabled();
  });
});
