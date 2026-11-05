/**
 * Copy buttons on a tool call's argument and result panes and on the
 * approval card's detail values: each hands the pane's own text to the shared
 * clipboard service, so nothing has to be drag-selected out of a scroll box.
 */
import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import { act } from '@brainstrike/test-utils/react-act';
import { TooltipProvider } from '@brainstrike/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../approval-card';
import { setAssistantDetailLevel } from '../assistant-detail-level-store.ts';
import { ToolFallback } from '../tool-fallback';
import type { ApprovalNoticeState } from '../use-approval-notice-state';

const clipboardMocks = vi.hoisted(() => ({ writeText: vi.fn() }));

vi.mock('@brainstrike/context-actions', () => ({
  createClipboardService: () => ({ writeText: clipboardMocks.writeText }),
}));

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
});

beforeEach(() => {
  clipboardMocks.writeText.mockReset();
  clipboardMocks.writeText.mockResolvedValue({ ok: true });
  // Before render, so the level change never re-renders a mounted card.
  setAssistantDetailLevel('standard');
});

/** Click a Copy button and let its copied state settle. */
async function copy(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

describe('tool call detail panes', () => {
  it('copies the formatted arguments and the result', async () => {
    setAssistantDetailLevel('developer');
    const Comp = ToolFallback as unknown as (p: Record<string, unknown>) => ReactElement;
    render(
      <TooltipProvider>
        <Comp
          addResult={() => {}}
          args={{ query: 'foo' }}
          argsText='{"query":"foo"}'
          result="3 matches in src"
          resume={() => {}}
          status={{ type: 'complete' }}
          toolCallId="call-copy-1"
          toolName="brainstrike.grepSearch"
          type="tool-call"
        />
      </TooltipProvider>
    );

    await copy('Copy arguments');
    expect(clipboardMocks.writeText).toHaveBeenLastCalledWith('{\n  "query": "foo"\n}');

    await copy('Copy result');
    expect(clipboardMocks.writeText).toHaveBeenLastCalledWith('3 matches in src');
  });
});

const approval: AssistantToolApprovalRequest = {
  args: { command: 'pnpm test' },
  resumeSchema: { type: 'object' },
  runId: 'run-copy-1',
  toolCallId: 'call-copy-2',
  toolName: 'brainstrike.executeCommand',
};

const pendingState: ApprovalNoticeState = {
  actionButtonsDisabled: false,
  answered: false,
  decisionLocked: false,
  delegationOwner: null,
  hostAnswer: null,
  rediscovered: null,
  sendError: null,
  status: 'Pending',
  submitApprovalAction: () => {},
};

function openApprovalDetails(): void {
  render(<ApprovalCard approval={approval} presentation="card" state={pendingState} />);
  fireEvent.click(screen.getByRole('button', { name: 'Expand tool approval details' }));
}

describe('approval card details', () => {
  it('labels each value in words and copies it', async () => {
    openApprovalDetails();

    expect(screen.getByText('Run ID')).toBeInTheDocument();
    expect(screen.getByText('Call ID')).toBeInTheDocument();
    expect(screen.getByText('Arguments')).toBeInTheDocument();

    await copy('Copy Run ID');
    expect(clipboardMocks.writeText).toHaveBeenLastCalledWith('run-copy-1');

    await copy('Copy Arguments');
    expect(clipboardMocks.writeText).toHaveBeenLastCalledWith('{\n  "command": "pnpm test"\n}');
  });

  it('shows the resume schema only at the Developer detail level', () => {
    openApprovalDetails();
    expect(screen.queryByText('Resume schema')).not.toBeInTheDocument();
  });

  it('shows the resume schema when raw I/O is on', () => {
    setAssistantDetailLevel('developer');
    openApprovalDetails();
    expect(screen.getByText('Resume schema')).toBeInTheDocument();
  });
});
