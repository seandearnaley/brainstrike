import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { personaLabelForToolName, SubagentExecutionCard } from '../subagent-execution-card';

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

  it('falls back to the raw tool name for an unknown key (never blank)', () => {
    expect(personaLabelForToolName('agent-ghost')).toBe('agent-ghost');
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
