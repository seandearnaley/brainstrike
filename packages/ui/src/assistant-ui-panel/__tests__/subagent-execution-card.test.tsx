import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { SubagentExecutionCard } from '../subagent-execution-card';
import { personaLabelForToolName } from '../subagent-persona-label';

function renderCard(props: Record<string, unknown>) {
  const Comp = SubagentExecutionCard as unknown as (p: Record<string, unknown>) => ReactElement;
  return render(<Comp {...props} />);
}

const completedResult = {
  subAgentToolResults: [
    {
      args: { pattern: 'flag' },
      isError: false,
      toolCallId: 'c1',
      toolName: 'brainstrike_grepSearch',
    },
    {
      args: { path: 'src/main.ts' },
      isError: false,
      toolCallId: 'c2',
      toolName: 'brainstrike_readWorkspaceFile',
    },
  ],
  text: 'Found the flag.',
};

describe('personaLabelForToolName', () => {
  it('resolves the built-in persona label', () => {
    expect(personaLabelForToolName('agent-explore')).toBe('Explorer');
    expect(personaLabelForToolName('agent-analyze')).toBe('Analyst');
  });

  it('falls back to the persona id for an unknown delegation tool (user personas)', () => {
    // User-defined personas are not in the static built-in label map; the
    // persona id (the file name) is the honest, never-blank label.
    expect(personaLabelForToolName('agent-security-auditor')).toBe('security-auditor');
  });

  it('falls back to the raw tool name for a non-delegation tool (never blank)', () => {
    expect(personaLabelForToolName('brainstrike.grepSearch')).toBe('brainstrike.grepSearch');
  });
});

describe('SubagentExecutionCard', () => {
  it('renders a completed delegation summary with the persona label and tool-call count', () => {
    renderCard({
      result: completedResult,
      status: { type: 'complete' },
      toolCallId: 'delegation-1',
      toolName: 'agent-explore',
    });
    expect(screen.getByText('Explorer subagent')).toBeTruthy();
    expect(screen.getByText('· Completed')).toBeTruthy();
    expect(screen.getByText('· 2 tool calls')).toBeTruthy();
    // Collapsed by default: child rows not shown until expanded.
    expect(screen.queryByText('brainstrike_grepSearch')).toBeNull();
  });

  it('lists the child tool rows on expand', () => {
    renderCard({
      result: completedResult,
      status: { type: 'complete' },
      toolCallId: 'delegation-1',
      toolName: 'agent-explore',
    });
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('brainstrike_grepSearch')).toBeTruthy();
    expect(screen.getByText('brainstrike_readWorkspaceFile')).toBeTruthy();
    expect(screen.getByText('flag')).toBeTruthy();
  });

  it('shows the running state before a result lands', () => {
    renderCard({
      result: undefined,
      status: { type: 'running' },
      toolCallId: 'delegation-1',
      toolName: 'agent-analyze',
    });
    expect(screen.getByText('Analyst subagent')).toBeTruthy();
    expect(screen.getByText('· Running')).toBeTruthy();
    expect(screen.getByText('· 0 tool calls')).toBeTruthy();
  });

  it('renders running child rows from live events only (never "Running · 0 tool calls")', () => {
    renderCard({
      liveRows: [
        {
          argSummary: undefined,
          key: 'child-1',
          status: 'running',
          toolName: 'brainstrike_grepSearch',
        },
      ],
      result: undefined,
      status: { type: 'running' },
      toolCallId: 'delegation-1',
      toolName: 'agent-explore',
    });
    expect(screen.getByText('· Running')).toBeTruthy();
    // The header count reflects the in-flight child tool, NOT zero.
    expect(screen.getByText('· 1 tool call')).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('brainstrike_grepSearch')).toBeTruthy();
  });

  it('persisted result rows supersede live rows by child toolCallId', () => {
    renderCard({
      liveRows: [
        { argSummary: undefined, key: 'c1', status: 'running', toolName: 'brainstrike_grepSearch' },
      ],
      result: completedResult,
      status: { type: 'complete' },
      toolCallId: 'delegation-1',
      toolName: 'agent-explore',
    });
    // c1 is superseded by the persisted (completed) row; total stays 2 (c1 + c2).
    expect(screen.getByText('· 2 tool calls')).toBeTruthy();
  });

  it('marks a failed child tool row as an error', () => {
    renderCard({
      result: {
        subAgentToolResults: [
          { args: {}, isError: true, toolCallId: 'c1', toolName: 'brainstrike_grepSearch' },
        ],
        text: '',
      },
      status: { type: 'complete' },
      toolCallId: 'delegation-1',
      toolName: 'agent-explore',
    });
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('brainstrike_grepSearch')).toBeTruthy();
  });
});
