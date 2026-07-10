import type {
  AssistantCheckpointRevertResult,
  AssistantEditCheckpointRecord,
} from '@brainstrike/assistant-contract';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../tooltip';
import {
  type EditCheckpointContextValue,
  EditCheckpointProvider,
} from '../edit-checkpoint-context';
import { ToolFallback } from '../tool-fallback';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

const TOOL_CALL_ID = 'call-1';

function makeEntry(
  overrides: Partial<AssistantEditCheckpointRecord> = {}
): AssistantEditCheckpointRecord {
  return {
    afterExisted: true,
    afterHash: 'after',
    beforeExisted: true,
    beforeHash: 'before',
    beforeSize: 10,
    captureStatus: 'ok',
    fromPath: null,
    id: 'ckpt-1',
    occurredAt: '2026-04-22T10:00:00.000Z',
    op: 'write',
    path: '/a.ts',
    resourceId: 'workspace-a',
    revertedAt: null,
    rootId: 'root-1',
    runId: 'run-1',
    threadId: 'thread-1',
    toolCallId: TOOL_CALL_ID,
    toolName: 'brainstrike.writeWorkspaceFile',
    ...overrides,
  };
}

function renderWithProvider(
  value: EditCheckpointContextValue | null,
  toolName = 'brainstrike.writeWorkspaceFile'
) {
  const Comp = ToolFallback as unknown as (p: Record<string, unknown>) => ReactElement;
  return render(
    <TooltipProvider>
      <EditCheckpointProvider value={value}>
        <Comp
          result={{ bytesWritten: 3, created: false }}
          status={{ type: 'complete' }}
          toolCallId={TOOL_CALL_ID}
          toolName={toolName}
        />
      </EditCheckpointProvider>
    </TooltipProvider>
  );
}

function contextValue(
  entry: AssistantEditCheckpointRecord,
  revertEntry: EditCheckpointContextValue['revertEntry']
): EditCheckpointContextValue {
  return {
    entries: [entry],
    entriesByToolCallId: new Map([[TOOL_CALL_ID, entry]]),
    revertEntry,
    revertRun: vi.fn(),
  };
}

describe('CheckpointRevertButton', () => {
  it('renders nothing when there is no provider (web / not desktop)', () => {
    renderWithProvider(null);
    expect(screen.queryByTestId('checkpoint-revert')).toBeNull();
  });

  it('renders nothing for a non-mutation tool even with a provider', () => {
    const value = contextValue(makeEntry(), vi.fn());
    renderWithProvider(value, 'brainstrike.queryEmbeddingSpace');
    expect(screen.queryByTestId('checkpoint-revert')).toBeNull();
  });

  it('confirms then reverts a revertible edit', async () => {
    const revertEntry = vi.fn(
      async (): Promise<AssistantCheckpointRevertResult> => ({
        entry: makeEntry({ revertedAt: '2026-04-22T11:00:00.000Z' }),
        ok: true,
      })
    );
    renderWithProvider(contextValue(makeEntry(), revertEntry));

    fireEvent.click(screen.getByTestId('checkpoint-revert'));
    fireEvent.click(screen.getByTestId('checkpoint-revert-confirm'));

    await waitFor(() => expect(revertEntry).toHaveBeenCalledWith('ckpt-1', undefined));
  });

  it('shows "Revert anyway" on a conflict and forces on retry', async () => {
    const revertEntry = vi
      .fn<EditCheckpointContextValue['revertEntry']>()
      .mockResolvedValueOnce({ code: 'conflict', id: 'ckpt-1', message: 'changed', ok: false })
      .mockResolvedValueOnce({ entry: makeEntry(), ok: true });
    renderWithProvider(contextValue(makeEntry(), revertEntry));

    fireEvent.click(screen.getByTestId('checkpoint-revert'));
    fireEvent.click(screen.getByTestId('checkpoint-revert-confirm'));
    await waitFor(() => expect(screen.getByTestId('checkpoint-revert-anyway')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('checkpoint-revert-anyway'));
    await waitFor(() => expect(revertEntry).toHaveBeenLastCalledWith('ckpt-1', { force: true }));
  });

  it('shows a disabled "Reverted" label for an already-reverted entry', () => {
    renderWithProvider(
      contextValue(makeEntry({ revertedAt: '2026-04-22T11:00:00.000Z' }), vi.fn())
    );
    expect(screen.getByTestId('checkpoint-reverted')).toBeInTheDocument();
    expect(screen.queryByTestId('checkpoint-revert')).toBeNull();
  });

  it('shows a non-revertible label for a skipped_binary capture', () => {
    renderWithProvider(contextValue(makeEntry({ captureStatus: 'skipped_binary' }), vi.fn()));
    expect(screen.getByTestId('checkpoint-unrevertible')).toBeInTheDocument();
    expect(screen.queryByTestId('checkpoint-revert')).toBeNull();
  });
});
