import type {
  McpTaskActionResult,
  McpTaskPresentation,
  McpTaskPresentationControllerPort,
} from '@brainstrike/assistant-contract/mcp-task-presentation';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { McpTaskStatusCard } from '../mcp-task-status-card';

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
    history: [
      { at: '2026-09-01T05:00:00.000Z', status: 'working' },
      { at: '2026-09-01T05:00:01.000Z', status: 'input_required' },
      { at: '2026-09-01T05:00:02.000Z', status: 'working' },
    ],
    omittedHistoryEntries: 24,
    recovery: 'restart_required',
    status: 'working',
    statusMessage: 'Preparing export',
    updatedAt: '2026-09-01T05:00:02.000Z',
    ...overrides,
  };
}

function controller(result: McpTaskActionResult | Promise<McpTaskActionResult>): {
  readonly act: ReturnType<typeof vi.fn<McpTaskPresentationControllerPort['act']>>;
  readonly port: McpTaskPresentationControllerPort;
} {
  const act = vi
    .fn<McpTaskPresentationControllerPort['act']>()
    .mockImplementation(() => Promise.resolve(result));
  return { act, port: { act } };
}

function ControlledCard({
  initialTask,
  port,
}: {
  readonly initialTask: McpTaskPresentation;
  readonly port: McpTaskPresentationControllerPort;
}): ReactElement {
  const [current, setCurrent] = useState(initialTask);
  return <McpTaskStatusCard controller={port} onTaskChange={setCurrent} task={current} />;
}

describe('McpTaskStatusCard', () => {
  it('renders bounded status history without exposing the control identity', () => {
    const control = controller({ ok: true, task: task() });
    const { container } = render(<ControlledCard initialTask={task()} port={control.port} />);

    expect(screen.getByRole('heading', { name: 'Background task' })).toBeInTheDocument();
    expect(screen.getByTestId('mcp-task-status-summary')).toHaveTextContent('Working');
    expect(screen.getByText('Preparing export')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('24 earlier updates omitted')).toBeInTheDocument();
    const text = container.textContent ?? '';
    for (const privateValue of Object.values(HANDLE)) {
      expect(text).not.toContain(String(privateValue));
    }
  });

  it('recovers through the exact opaque handle and moves focus to the recovered status', async () => {
    const recovered = task({
      recovery: 'live',
      statusMessage: 'Recovery resumed',
      updatedAt: '2026-09-01T05:00:03.000Z',
    });
    const control = controller({ ok: true, task: recovered });
    const user = userEvent.setup();
    render(<ControlledCard initialTask={task()} port={control.port} />);

    await user.click(screen.getByRole('button', { name: 'Recover task' }));

    expect(control.act).toHaveBeenCalledWith({ action: 'recover', handle: HANDLE });
    expect(await screen.findByText('Recovery resumed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recover task' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('mcp-task-status-summary')).toHaveFocus());
  });

  it('does not report cancellation until the authority observes remote cancelled', async () => {
    const pending = Promise.withResolvers<McpTaskActionResult>();
    const control = controller(pending.promise);
    const user = userEvent.setup();
    render(<ControlledCard initialTask={task({ recovery: 'live' })} port={control.port} />);

    await user.click(screen.getByRole('button', { name: 'Cancel task' }));

    expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
    expect(screen.getByTestId('mcp-task-status-summary')).toHaveTextContent('Working');
    expect(screen.queryByText('Cancelled')).not.toBeInTheDocument();

    pending.resolve({
      ok: true,
      task: task({
        canCancel: false,
        recovery: 'terminal',
        status: 'cancelled',
        statusMessage: 'Cancelled by user',
        updatedAt: '2026-09-01T05:00:04.000Z',
      }),
    });

    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('mcp-task-status-summary')).toHaveFocus());
  });

  it.each([
    ['stale_handle', 'This MCP task handle belongs to a replaced server connection.'],
    ['lost_principal', 'The authorization principal that owns this MCP task is unavailable.'],
    ['unsupported_version', 'MCP Tasks controls require protocol 2026-07-28.'],
    ['capability_removed', 'This server no longer advertises the MCP Tasks capability.'],
  ] as const)('surfaces and focuses the stable %s diagnostic', async (code, message) => {
    const control = controller({ diagnostic: { code, message }, ok: false });
    const user = userEvent.setup();
    render(<ControlledCard initialTask={task()} port={control.port} />);

    await user.click(screen.getByRole('button', { name: 'Recover task' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveFocus();
  });

  it('does not expose an unexpected authority error', async () => {
    const act = vi
      .fn<McpTaskPresentationControllerPort['act']>()
      .mockRejectedValue(new Error('Bearer private-token at /private/path'));
    const user = userEvent.setup();
    render(<ControlledCard initialTask={task()} port={{ act }} />);

    await user.click(screen.getByRole('button', { name: 'Recover task' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('MCP task recovery failed.');
    expect(alert).not.toHaveTextContent('private-token');
    expect(alert).not.toHaveTextContent('/private/path');
  });

  it('keeps actions single-flight while the controller is pending', async () => {
    const pending = Promise.withResolvers<McpTaskActionResult>();
    const control = controller(pending.promise);
    const user = userEvent.setup();
    render(<ControlledCard initialTask={task()} port={control.port} />);

    await user.dblClick(screen.getByRole('button', { name: 'Recover task' }));

    expect(control.act).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Recovering…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel task' })).toBeDisabled();

    pending.resolve({ ok: true, task: task({ recovery: 'live' }) });
    await waitFor(() => expect(screen.queryByText('Recovering…')).not.toBeInTheDocument());
  });

  it('keeps the same authority handle single-flight across newer live updates', async () => {
    const pending = Promise.withResolvers<McpTaskActionResult>();
    const control = controller(pending.promise);
    const onTaskChange = vi.fn<(nextTask: McpTaskPresentation) => void>();
    const user = userEvent.setup();
    const original = task({ recovery: 'live' });
    const newerObservation = task({
      recovery: 'live',
      statusMessage: 'Still working after a newer poll',
      updatedAt: '2026-09-01T05:00:03.000Z',
    });
    const view = render(
      <McpTaskStatusCard controller={control.port} onTaskChange={onTaskChange} task={original} />
    );

    await user.click(screen.getByRole('button', { name: 'Cancel task' }));
    view.rerender(
      <McpTaskStatusCard
        controller={control.port}
        onTaskChange={onTaskChange}
        task={newerObservation}
      />
    );

    expect(screen.getByText('Still working after a newer poll')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancelling…' }));
    expect(control.act).toHaveBeenCalledTimes(1);

    const cancelled = task({
      canCancel: false,
      recovery: 'terminal',
      status: 'cancelled',
      statusMessage: 'Cancelled by user',
      updatedAt: '2026-09-01T05:00:04.000Z',
    });
    pending.resolve({ ok: true, task: cancelled });

    await waitFor(() => expect(onTaskChange).toHaveBeenCalledWith(cancelled));
  });

  it('renders fractional-second timestamps as UTC', () => {
    render(
      <ControlledCard
        initialTask={task({
          createdAt: '2026-09-01T05:00:00.123Z',
          updatedAt: '2026-09-01T05:00:07.999Z',
        })}
        port={controller({ ok: true, task: task() }).port}
      />
    );
    expect(screen.getByText(/2026-09-01 05:00:07 UTC/u)).toBeInTheDocument();
    expect(screen.queryByText(/\.999Z/u)).toBeNull();
  });

  it('keeps a newer same-handle observation over an older action outcome', async () => {
    const pending = Promise.withResolvers<McpTaskActionResult>();
    const control = controller(pending.promise);
    const onTaskChange = vi.fn<(nextTask: McpTaskPresentation) => void>();
    const user = userEvent.setup();
    const original = task();
    const newer = task({
      status: 'input_required',
      statusMessage: 'Newer observation',
      updatedAt: '2026-09-01T05:00:09.000Z',
    });
    const view = render(
      <McpTaskStatusCard controller={control.port} onTaskChange={onTaskChange} task={original} />
    );
    await user.click(screen.getByRole('button', { name: 'Recover task' }));
    view.rerender(
      <McpTaskStatusCard controller={control.port} onTaskChange={onTaskChange} task={newer} />
    );

    pending.resolve({
      ok: true,
      task: task({ recovery: 'live', updatedAt: '2026-09-01T05:00:03.000Z' }),
    });
    await waitFor(() => expect(control.act).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Recover task' })).toBeEnabled());
    expect(onTaskChange).not.toHaveBeenCalled();
    expect(screen.getByText('Newer observation')).toBeInTheDocument();
  });

  it('does not let an action for a replaced task overwrite the new card task', async () => {
    const pending = Promise.withResolvers<McpTaskActionResult>();
    const control = controller(pending.promise);
    const onTaskChange = vi.fn<(nextTask: McpTaskPresentation) => void>();
    const user = userEvent.setup();
    const original = task();
    const replacement = task({
      handle: {
        ...HANDLE,
        authorityEpoch: '00000000-0000-7000-8000-000000000001',
      },
      recovery: 'live',
      statusMessage: 'Replacement task is live',
      updatedAt: '2026-09-01T05:00:05.000Z',
    });
    const view = render(
      <McpTaskStatusCard controller={control.port} onTaskChange={onTaskChange} task={original} />
    );

    await user.click(screen.getByRole('button', { name: 'Recover task' }));
    view.rerender(
      <McpTaskStatusCard controller={control.port} onTaskChange={onTaskChange} task={replacement} />
    );

    expect(screen.getByText('Replacement task is live')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel task' })).toBeEnabled();

    pending.resolve({ ok: true, task: task({ recovery: 'live' }) });
    await waitFor(() => expect(control.act).toHaveBeenCalledTimes(1));

    expect(onTaskChange).not.toHaveBeenCalled();
    expect(screen.getByText('Replacement task is live')).toBeInTheDocument();

    // Rendering the original handle again must not resurrect the abandoned
    // action as a permanently disabled control.
    view.rerender(
      <McpTaskStatusCard controller={control.port} onTaskChange={onTaskChange} task={original} />
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Recover task' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Cancel task' })).toBeEnabled();
  });
});
