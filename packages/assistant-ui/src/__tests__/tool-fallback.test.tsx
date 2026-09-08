import type { AssistantEditCheckpointRecord } from '@brainstrike/assistant-contract';
import { TooltipProvider } from '@brainstrike/ui';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
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

function renderTool(props: Record<string, unknown>) {
  const Comp = ToolFallback as unknown as (p: Record<string, unknown>) => ReactElement;
  return render(
    <TooltipProvider>
      <Comp {...props} />
    </TooltipProvider>
  );
}

describe('ToolFallback', () => {
  it('renders an internal tool with category attr and no redundant status badge', () => {
    renderTool({
      argsText: '{"q":"x"}',
      result: { ok: true },
      status: { type: 'complete' },
      toolName: 'brainstrike.queryEmbeddingSpace',
    });
    const card = screen.getByTestId('tool-fallback');
    expect(card.getAttribute('data-tool-category')).toBe('internal');
    expect(screen.queryByText('Completed')).toBeNull();
  });

  it('classifies a non-brainstrike tool as mcp and reveals args + result on expand', () => {
    renderTool({
      argsText: '{"q":"x"}',
      result: { answer: 42 },
      status: { type: 'complete' },
      toolName: 'searchDocs',
    });
    const card = screen.getByTestId('tool-fallback');
    expect(card.getAttribute('data-tool-category')).toBe('mcp');
    fireEvent.click(screen.getByRole('button', { name: /expand/i }));
    expect(screen.getByText(/Arguments/i)).toBeInTheDocument();
    expect(screen.getByText(/Result/i)).toBeInTheDocument();
  });

  it('renders a persisted guarded result as failed when the tool part isError flag is set', () => {
    renderTool({
      argsText: '{"path":"package.json"}',
      isError: true,
      result: {
        error: {
          code: 'tool_failed',
          message: 'The tool did not complete successfully. Try another approach.',
        },
        ok: false,
      },
      status: { type: 'complete' },
      toolName: 'brainstrike.readWorkspaceFile',
    });

    expect(screen.getByRole('img', { name: 'Failed' })).toBeInTheDocument();
    expect(
      screen.getByText('The tool did not complete successfully. Try another approach.')
    ).toBeInTheDocument();
  });

  it('does not classify a successful payload with nested error metadata as failed', () => {
    renderTool({
      argsText: '{}',
      result: { error: { message: 'advisory only' }, ok: true },
      status: { type: 'complete' },
      toolName: 'lookupStatus',
    });

    expect(screen.getByTestId('tool-fallback')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Failed' })).toBeNull();
    expect(screen.queryByText('advisory only')).toBeNull();
  });

  it('renders a declined tool call as Stopped — never Completed, never Failed', () => {
    // BST-1282: a call the user declined at its approval gate settles with the
    // shared `DeclinedToolCallResult` envelope. A settled result alone would
    // earn the green Completed check for a tool that never ran, and an error
    // flag would paint destructive Failed chrome over something that did not
    // break. It is the user's choice, so it takes the muted Stopped treatment.
    renderTool({
      argsText: '{"command":"rm -rf /"}',
      result: {
        kind: 'declined',
        message: 'The user declined this tool call, so it was not executed.',
        reason: 'not this path',
      },
      status: { type: 'complete' },
      toolName: 'brainstrike.executeCommand',
    });

    expect(screen.getByRole('img', { name: 'Stopped' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Failed' })).toBeNull();
    expect(screen.queryByRole('img', { name: 'Completed' })).toBeNull();
  });

  it('keeps an ordinary settled result on the Completed path', () => {
    // Guards the decline check above from swallowing every settled result.
    renderTool({
      argsText: '{"q":"x"}',
      result: { kind: 'something-else', ok: true },
      status: { type: 'complete' },
      toolName: 'searchDocs',
    });

    expect(screen.queryByRole('img', { name: 'Stopped' })).toBeNull();
    expect(screen.getByRole('img', { name: 'Completed' })).toBeInTheDocument();
  });

  it('does not serialize the result while the details pane is collapsed', () => {
    // Tool results are budgeted at ~3k tokens (~12 KB serialized); every card
    // in the streaming turn re-renders per chunk, so an eager JSON.stringify
    // of a collapsed card's result is pure per-chunk waste. Serialization must
    // only happen once the details pane is actually open.
    let deepReads = 0;
    const result = {
      ok: true,
      get payloadBlob() {
        deepReads += 1;
        return 'x'.repeat(64);
      },
    };
    renderTool({
      argsText: '{"q":"x"}',
      result,
      status: { type: 'complete' },
      toolName: 'searchDocs',
    });

    expect(deepReads).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: /expand/i }));
    expect(screen.getByText(/Result/i)).toBeInTheDocument();
    expect(deepReads).toBeGreaterThan(0);
  });
});

/**
 * BST-1681 phase 3: the card header IS the activity step row — a verb in
 * tense, the target chip, the state glyph, and (only when there is a details
 * pane to open) the row itself as the toggle.
 */
describe('ToolFallback activity step row', () => {
  const READ_TOOL = 'brainstrike.readWorkspaceFile';

  it('renders a running call as a non-interactive Reading row with exactly one live mark', () => {
    const { container } = renderTool({
      args: { path: 'src/app.ts' },
      argsText: '{"path":"src/app.ts"}',
      status: { type: 'running' },
      toolCallId: 'call-running',
      toolName: READ_TOOL,
    });

    const card = screen.getByTestId('tool-fallback');
    // Nothing to expand while the call runs (`showDetails` is false), so the
    // row is a `role="group"` div — never a button that opens nothing.
    expect(within(card).queryByRole('button')).toBeNull();
    expect(screen.getByText('Reading')).toBeInTheDocument();
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Running' })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-live="true"]')).toHaveLength(1);
  });

  it('renders a settled call as the row toggle: Read verb, Completed glyph, sr-only tool id', () => {
    renderTool({
      args: { path: 'src/app.ts' },
      argsText: '{"path":"src/app.ts"}',
      result: { content: 'export {}' },
      status: { type: 'complete' },
      toolCallId: 'call-done',
      toolName: READ_TOOL,
    });

    const card = screen.getByTestId('tool-fallback');
    expect(card).toHaveAttribute('data-tool-category', 'internal');
    expect(screen.getByRole('img', { name: 'Completed' })).toBeInTheDocument();

    const row = screen.getByRole('button', { name: 'Expand details' });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    const describedBy = row.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    if (describedBy === null) {
      throw new Error('unreachable: asserted truthy above');
    }
    const content = document.getElementById(describedBy);
    expect(content).toHaveTextContent('Read');
    expect(content).toHaveTextContent('src/app.ts');
    // The raw id stays IN the card as text (the e2e contract) but out of the
    // row's own accessible description.
    expect(within(card).getByText(READ_TOOL)).toHaveClass('sr-only');
    expect(content).not.toHaveTextContent(READ_TOOL);

    fireEvent.click(row);
    const expanded = screen.getByRole('button', { name: 'Collapse details' });
    expect(expanded).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Arguments:')).toBeInTheDocument();
  });

  it('reads a resultless settled call as Waiting for approval with a static glyph', () => {
    const { container } = renderTool({
      args: { command: 'rm x' },
      argsText: '{"command":"rm x"}',
      status: { type: 'complete' },
      toolCallId: 'call-paused',
      toolName: 'brainstrike.executeCommand',
    });

    expect(screen.getByRole('img', { name: 'Waiting for approval' })).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).toBeNull();
    expect(container.querySelectorAll('[data-live="true"]')).toHaveLength(0);
  });

  it('keeps the done-tense verb on a failed call and still renders the error line', () => {
    renderTool({
      args: { path: 'src/app.ts' },
      argsText: '{"path":"src/app.ts"}',
      isError: true,
      result: { error: { code: 'tool_failed', message: 'Read failed.' }, ok: false },
      status: { type: 'complete' },
      toolCallId: 'call-failed',
      toolName: READ_TOOL,
    });

    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Failed' })).toBeInTheDocument();
    expect(screen.getByText('Read failed.')).toBeInTheDocument();
  });

  it('places the checkpoint revert control beside the row, never inside it', () => {
    const entry: AssistantEditCheckpointRecord = {
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
      toolCallId: 'call-write',
      toolName: 'brainstrike.writeWorkspaceFile',
    };
    const value: EditCheckpointContextValue = {
      availabilityById: new Map([[entry.id, { restorable: true }]]),
      entries: [entry],
      entriesByToolCallId: new Map([['call-write', entry]]),
      revertEntry: vi.fn(),
      revertRun: vi.fn(),
    };
    const Comp = ToolFallback as unknown as (p: Record<string, unknown>) => ReactElement;
    render(
      <TooltipProvider>
        <EditCheckpointProvider value={value}>
          <Comp
            args={{ path: '/a.ts' }}
            argsText='{"path":"/a.ts"}'
            result={{ bytesWritten: 3, created: false }}
            status={{ type: 'complete' }}
            toolCallId="call-write"
            toolName="brainstrike.writeWorkspaceFile"
          />
        </EditCheckpointProvider>
      </TooltipProvider>
    );

    const row = screen.getByTestId('activity-step-row');
    const revert = screen.getByTestId('checkpoint-revert');
    expect(row.contains(revert)).toBe(false);
    expect(row.nextElementSibling?.contains(revert)).toBe(true);
  });
});
