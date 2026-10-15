import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextUsageMeter } from '../context-usage-meter.js';
import { resetContextUsageStore, useContextUsageStore } from '../context-usage-store.js';

vi.mock('@assistant-ui/react', () => ({
  useAuiState: <T,>(
    selector: (state: { thread: { isRunning: boolean; messages: unknown[] } }) => T
  ) => selector({ thread: { isRunning: false, messages: [] } }),
}));

function openMeterPopover(): void {
  fireEvent.focus(screen.getByTestId('context-usage-trigger'));
}

describe('ContextUsageMeter tool-call attribution (inside the popover)', () => {
  beforeEach(() => {
    resetContextUsageStore();
  });

  const props = {
    contextWindow: 200_000,
    effectiveInputBudget: 126_000,
    threadKey: 't1',
  };

  it('attributes tool calls and results as their own category, out of Unattributed', () => {
    useContextUsageStore.getState().recordBreakdown('t1', {
      breakdown: {
        attachmentsCount: 0,
        historyMessagesTokens: 900,
        provenance: 'heuristic',
        systemInstructionsTokens: 1200,
        toolCallsByTool: [
          { calls: 3, tokens: 2600, toolName: 'brainstrike.readWorkspaceFile' },
          { calls: 2, tokens: 400, toolName: 'brainstrike.grepSearch' },
        ],
        toolCallsTokens: 3000,
      },
      invalid: false,
    });
    useContextUsageStore.getState().recordUsage('t1', { inputTokens: 10_000, outputTokens: 500 });
    render(<ContextUsageMeter {...props} />);
    openMeterPopover();
    expect(screen.getByTestId('context-usage-breakdown-tool-calls')).toHaveTextContent(
      /Tool calls and results/
    );
    expect(screen.getByTestId('context-usage-breakdown-tool-calls')).toHaveTextContent(/3\.0K/);
    expect(screen.getByTestId('context-usage-toolcall-0')).toHaveTextContent(
      /brainstrike\.readWorkspaceFile/
    );
    expect(screen.getByTestId('context-usage-toolcall-1')).toHaveTextContent(/400/);
    // 10_000 − (1200 + 900 + 3000) = 4_900
    expect(screen.getByTestId('context-usage-breakdown-unattributed')).toHaveTextContent(/4\.9K/);
  });

  it('keeps tool activity out of the Conversation split when tool calls have their own row', () => {
    useContextUsageStore.getState().recordBreakdown('t1', {
      breakdown: {
        attachmentsCount: 0,
        historyMessagesTokens: 900,
        provenance: 'heuristic',
        systemInstructionsTokens: 1200,
        toolCallsByTool: [{ calls: 1, tokens: 10_000, toolName: 'run_shell' }],
        toolCallsTokens: 10_000,
      },
      invalid: false,
    });
    render(
      <ContextUsageMeter
        {...props}
        conversationEstimate={{
          assistantTextTokens: 500,
          attachmentsCount: 0,
          byTool: [{ name: 'run_shell', tokens: 10_000 }],
          reasoningTokens: 0,
          toolTokens: 10_000,
          totalTokens: 10_800,
          userTextTokens: 300,
        }}
      />
    );
    openMeterPopover();
    expect(screen.getByTestId('context-usage-conv-user')).toBeInTheDocument();
    expect(screen.queryByTestId('context-usage-conv-tools')).not.toBeInTheDocument();
    expect(screen.queryByTestId('context-usage-conv-tool-0')).not.toBeInTheDocument();
  });

  it('shows no tool-call row beside a client-estimated conversation, which already counts tools', () => {
    useContextUsageStore.getState().recordBreakdown('t1', {
      breakdown: {
        attachmentsCount: 0,
        provenance: 'heuristic',
        systemInstructionsTokens: 1200,
        toolCallsByTool: [{ calls: 1, tokens: 500, toolName: 'run_shell' }],
        toolCallsTokens: 500,
      },
      invalid: false,
    });
    render(<ContextUsageMeter {...props} estimatedTokens={4000} />);
    openMeterPopover();
    expect(screen.queryByTestId('context-usage-breakdown-tool-calls')).not.toBeInTheDocument();
  });
});
