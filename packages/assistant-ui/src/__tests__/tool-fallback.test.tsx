import type { AssistantEditCheckpointRecord } from '@brainstrike/assistant-contract';
import { TooltipProvider } from '@brainstrike/ui';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type EditCheckpointContextValue,
  EditCheckpointProvider,
} from '../edit-checkpoint-context';
import { ToolFallback } from '../tool-fallback';
import { type LooseProps, toolPartElement } from './tool-part-render';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

function renderTool(props: LooseProps<ComponentProps<typeof ToolFallback>>) {
  return render(<TooltipProvider>{toolPartElement(ToolFallback, props)}</TooltipProvider>);
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

  it('keeps an ok: true result carrying an advisory error STRING on the Completed path', () => {
    // Bot round 1 (Claude Important 1 / Codex P2 #1). The card and the trace
    // read ONE function (`readResultError`), and it reads the success
    // discriminator first: a result that says it succeeded never grows failed
    // chrome or a red error line because it also carries advice in `error`.
    renderTool({
      argsText: '{}',
      result: { error: 'warning: deprecated flag', ok: true },
      status: { type: 'complete' },
      toolName: 'lookupStatus',
    });

    expect(screen.getByRole('img', { name: 'Completed' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Failed' })).toBeNull();
    expect(screen.queryByText('warning: deprecated flag')).toBeNull();
  });

  it('renders the error line for a bare error string, with no ok discriminator', () => {
    // The other side of the same reader: nothing claims success here, so the
    // stated message IS the failure — Failed chrome plus the message verbatim.
    renderTool({
      argsText: '{}',
      result: { error: 'boom' },
      status: { type: 'complete' },
      toolName: 'lookupStatus',
    });

    expect(screen.getByRole('img', { name: 'Failed' })).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
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

    // BST-1682 (WCAG 2.5.3): the row's own name carries the visible verb and
    // target, with the affordance trailing as a clause. Exact, not a
    // `/Read/` substring: that also passes on "Reading", so it could not tell
    // the done tense from the active one.
    const row = screen.getByRole('button', { name: 'Read src/app.ts, expand details' });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    // The content is the name, so it is not repeated as a description.
    expect(row).not.toHaveAttribute('aria-describedby');
    const content = card.querySelector<HTMLElement>('.bs-step-row-content');
    if (content === null) {
      throw new Error('unreachable: the row always renders its content span');
    }
    expect(within(content).getByText('Read', { exact: true })).toBeInTheDocument();
    expect(content).toHaveTextContent('src/app.ts');
    // The raw id stays IN the card as text (the e2e contract) but out of the
    // row's own accessible name — nobody SEES it, so no speech-input user can
    // say it.
    expect(within(card).getByText(READ_TOOL)).toHaveClass('sr-only');
    expect(content).not.toHaveTextContent(READ_TOOL);
    expect(row).toHaveAccessibleName('Read src/app.ts, expand details');

    fireEvent.click(row);
    const expanded = screen.getByRole('button', { name: 'Read src/app.ts, collapse details' });
    expect(expanded).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Arguments:')).toBeInTheDocument();
  });

  it('falls back to the tool id as the target when the args name none', () => {
    // Bot round 1, Claude Important 4. `extractPrimaryArg` finds nothing in
    // `{}`, and a bare "Read" with an empty target slot says less than the id
    // itself — which the row otherwise carries only as sr-only text and as its
    // `title`, so the chip is the only place it is VISIBLE.
    const { container } = renderTool({
      args: {},
      argsText: '{}',
      result: { content: '' },
      status: { type: 'complete' },
      toolCallId: 'call-no-arg',
      toolName: 'brainstrike.readWorkspaceFile',
    });

    expect(container.querySelector('.bs-step-row-target')).toHaveTextContent(
      'brainstrike.readWorkspaceFile'
    );
  });

  it('does not repeat the id as the target when the fallback verb already names it', () => {
    // "Called legacy.echo · legacy.echo" was the first cut of the fallback;
    // `verbForTool` flags the generic verbs with `namesTool` so the chip stays
    // empty and the id is read once.
    const { container } = renderTool({
      args: {},
      argsText: '{}',
      result: { ok: true },
      status: { type: 'complete' },
      toolCallId: 'call-mcp-no-arg',
      toolName: 'legacy.echo',
    });

    const card = screen.getByTestId('tool-fallback');
    expect(within(card).getByText('Called legacy.echo', { exact: true })).toBeInTheDocument();
    expect(container.querySelector('.bs-step-row-target')).toBeNull();
    expect(card).toHaveTextContent('legacy.echo');
  });

  it('reads a LIVE paused call (requires-action) as Waiting for approval, with no live mark', () => {
    const { container } = renderTool({
      args: { command: 'rm x' },
      argsText: '{"command":"rm x"}',
      status: { reason: 'tool-calls', type: 'requires-action' },
      toolCallId: 'call-paused',
      toolName: 'brainstrike.executeCommand',
    });

    expect(screen.getByRole('img', { name: 'Waiting for approval' })).toBeInTheDocument();
    // The gate is on the USER, not on the model: the row must not shimmer or
    // carry the live mark while it waits.
    expect(container.querySelectorAll('[data-live="true"]')).toHaveLength(0);
    // ACTIVE tense (bot round 1, Claude Important 3): the step is in flight,
    // paused on the user — the done tense would assert "Ran rm x" of a command
    // that has not run at all. The glyph is what says why it is not moving.
    expect(screen.getByText('Running', { exact: true })).toBeInTheDocument();
    expect(screen.queryByText('Ran', { exact: true })).toBeNull();
  });

  it('reads a resultless call on a settled message as Completed, like the trace does', () => {
    // The card used to call this one "Waiting for approval" while the trace
    // called it `done` — the same step reading two states. A reload after an
    // abandoned approval is a PERSISTENCE gap (BST-1678), not something the
    // card may invent an outcome for.
    renderTool({
      args: { command: 'rm x' },
      argsText: '{"command":"rm x"}',
      status: { type: 'complete' },
      toolCallId: 'call-resultless',
      toolName: 'brainstrike.executeCommand',
    });

    expect(screen.getByRole('img', { name: 'Completed' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Waiting for approval' })).toBeNull();
    expect(screen.getByText('Ran', { exact: true })).toBeInTheDocument();
  });

  it('reads a cancelled call as Stopped — never the destructive Failed chrome', () => {
    renderTool({
      args: { command: 'sleep 100' },
      argsText: '{"command":"sleep 100"}',
      status: { reason: 'cancelled', type: 'incomplete' },
      toolCallId: 'call-cancelled',
      toolName: 'brainstrike.executeCommand',
    });

    expect(screen.getByRole('img', { name: 'Stopped' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Failed' })).toBeNull();
    // `resolveErrorMessage` still composes "Tool incomplete: cancelled" for
    // this status, but the error line renders only under the failed state —
    // a stop the user asked for is not an error to report in red.
    expect(screen.queryByText('Tool incomplete: cancelled')).toBeNull();
    expect(screen.getByText('Ran', { exact: true })).toBeInTheDocument();
  });

  it('reads an incomplete call with a non-cancelled reason as Failed, with its error line', () => {
    renderTool({
      args: { command: 'sleep 100' },
      argsText: '{"command":"sleep 100"}',
      status: { reason: 'error', type: 'incomplete' },
      toolCallId: 'call-incomplete',
      toolName: 'brainstrike.executeCommand',
    });

    expect(screen.getByRole('img', { name: 'Failed' })).toBeInTheDocument();
    expect(screen.getByText('Tool incomplete: error')).toBeInTheDocument();
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
    const { revert, row } = renderCheckpointCard({ type: 'complete' });
    expect(row.contains(revert)).toBe(false);
    expect(row.nextElementSibling?.contains(revert)).toBe(true);
  });

  // Task 4 review, Minor 2. A checkpoint exists only because the mutation
  // actually landed on disk, so a call the user STOPPED afterwards is exactly
  // the case where the undo matters most — and the card must not treat the
  // muted Stopped chrome as "nothing to revert". Only `running` (no edit yet)
  // and `failed` (its own error line owns the row) withhold the control.
  it('keeps the revert control on a cancelled call whose edit already landed', () => {
    const { revert, row } = renderCheckpointCard({ reason: 'cancelled', type: 'incomplete' });
    expect(within(row).getByRole('img', { name: 'Stopped' })).toBeInTheDocument();
    expect(row.contains(revert)).toBe(false);
    expect(row.nextElementSibling?.contains(revert)).toBe(true);
  });
});

/**
 * A settled write with a captured, restorable checkpoint — the shape the
 * revert control needs to render at all.
 */
function renderCheckpointCard(status: ComponentProps<typeof ToolFallback>['status']): {
  revert: HTMLElement;
  row: HTMLElement;
} {
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
  render(
    <TooltipProvider>
      <EditCheckpointProvider value={value}>
        {toolPartElement(ToolFallback, {
          args: { path: '/a.ts' },
          argsText: '{"path":"/a.ts"}',
          result: { bytesWritten: 3, created: false },
          status,
          toolCallId: 'call-write',
          toolName: 'brainstrike.writeWorkspaceFile',
        })}
      </EditCheckpointProvider>
    </TooltipProvider>
  );

  return {
    revert: screen.getByTestId('checkpoint-revert'),
    row: screen.getByTestId('activity-step-row'),
  };
}
