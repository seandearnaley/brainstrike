import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type SubagentCardProps, SubagentExecutionCard } from '../subagent-execution-card';
import { personaLabelForToolName } from '../subagent-persona-label';
import { type LooseProps, toolPartElement } from './tool-part-render';

function renderCard(props: LooseProps<SubagentCardProps>) {
  return render(toolPartElement(SubagentExecutionCard, props));
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
  it('shows a delegation that ran but never answered as "No answer", not Completed', () => {
    // BST-1410. The delegation tool call succeeds even when the child exhausts
    // its step cap mid-tool-loop and writes nothing, so `status.type` alone
    // reports it as Completed — the same silent success that misled the model.
    renderCard({
      outcome: 'no-answer',
      result: completedResult,
      status: { type: 'complete' },
      toolCallId: 'delegation-1',
      toolName: 'agent-explore',
    });
    // BST-1681: the verb slot names the outcome; the glyph carries the state.
    expect(screen.getByText('Explorer gave no answer')).toBeTruthy();
    expect(screen.queryByText('Explorer finished')).toBeNull();
    expect(screen.getByRole('img', { name: 'No answer' })).toBeTruthy();
    // Still a real delegation with real child work: the rows stay browsable.
    expect(screen.getByText('· 2 tool calls')).toBeTruthy();
  });

  it('renders a completed delegation summary with the persona label and tool-call count', () => {
    renderCard({
      result: completedResult,
      status: { type: 'complete' },
      toolCallId: 'delegation-1',
      toolName: 'agent-explore',
    });
    expect(screen.getByText('Explorer finished')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Completed' })).toBeTruthy();
    expect(screen.getByText('· 2 tool calls')).toBeTruthy();
    // The raw delegation tool id stays readable text (the e2e contract).
    expect(screen.getByText('agent-explore')).toBeTruthy();
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
    expect(screen.getByText('Delegating to Analyst')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Running' })).toBeTruthy();
    expect(screen.getByText('· 0 tool calls')).toBeTruthy();
    // No child rows yet: nothing to expand, so the row is not a button.
    expect(screen.queryByRole('button')).toBeNull();
  });

  // Task 5 review, Important 2: `resolveDisplayStatus` mapped EVERY
  // `incomplete` status to `error`, so a delegation the user stopped read
  // "<Label> failed" under destructive chrome while the group summary — which
  // reads `toolStepStateFor` — called the same step Stopped. One step, one
  // state machine; the delegation-only refinement ('no-answer') rides on top
  // of `done` and nothing else.
  it('shows a stopped delegation as stopped, never failed', () => {
    const { container } = renderCard({
      result: undefined,
      status: { reason: 'cancelled', type: 'incomplete' },
      toolCallId: 'delegation-1',
      toolName: 'agent-explore',
    });
    expect(screen.getByText('Explorer stopped')).toBeTruthy();
    expect(screen.queryByText('Explorer failed')).toBeNull();
    expect(screen.getByRole('img', { name: 'Stopped' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Failed' })).toBeNull();
    // Nothing broke, so nothing wears the destructive chrome.
    expect(container.querySelectorAll('.text-destructive')).toHaveLength(0);
  });

  // Task 5 fix-wave gap: `SubagentCardProps` picked only the tool-part fields
  // the card happened to read, so the part-level `isError` flag never reached
  // it. A delegation the runtime flagged as errored — with a status of
  // `complete` and a result that does not state the failure itself — then read
  // "Explorer finished" here while the group summary, which does see the flag,
  // counted the same step as failed. One flag, one verdict.
  it('reads a part-level isError flag as a failed delegation', () => {
    renderCard({
      isError: true,
      result: completedResult,
      status: { type: 'complete' },
      toolCallId: 'delegation-1',
      toolName: 'agent-explore',
    });
    expect(screen.getByText('Explorer failed')).toBeTruthy();
    expect(screen.queryByText('Explorer finished')).toBeNull();
    expect(screen.getByRole('img', { name: 'Failed' })).toBeTruthy();
  });

  it('shows a delegation paused at its approval gate as waiting, not running', () => {
    // `toolStepStateFor` CAN return 'waiting' for a delegation (a
    // `requires-action` part), so the verb table has to be total over it. The
    // delegation has not started, so the verb stays the present-tense
    // "Delegating to <Label>" while the glyph names the pause.
    const { container } = renderCard({
      result: undefined,
      status: { reason: 'tool-calls', type: 'requires-action' },
      toolCallId: 'delegation-1',
      toolName: 'agent-explore',
    });
    expect(screen.getByText('Delegating to Explorer')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Waiting for approval' })).toBeTruthy();
    // A gated call is not live: nothing pulses while the user decides.
    expect(container.querySelectorAll('[data-live="true"]')).toHaveLength(0);
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
    expect(screen.getByText('Delegating to Explorer')).toBeTruthy();
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

  it('marks the running step glyph data-live, exactly once', () => {
    const { container } = renderCard({
      result: undefined,
      status: { type: 'running' },
      toolCallId: 'p1',
      toolName: 'agent-explorer',
    });
    // BST-1681: the row's state glyph owns the liveness (the shared thinking
    // mark, whose motion is stylesheet-owned and reduced-motion aware), so a
    // running delegation carries exactly one live element.
    const live = container.querySelectorAll('[data-live="true"]');
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveAttribute('data-testid', 'step-running-mark');
  });

  it('renders no data-live element once the delegation has a result', () => {
    const { container } = renderCard({
      result: completedResult,
      status: { type: 'complete' },
      toolCallId: 'p1',
      toolName: 'agent-explorer',
    });
    expect(container.querySelectorAll('[data-live="true"]')).toHaveLength(0);
  });

  it('renders an interrupted child row static and not data-live', () => {
    const { container } = renderCard({
      liveRows: [
        {
          argSummary: undefined,
          key: 'c1',
          status: 'interrupted',
          toolName: 'brainstrike_grepSearch',
        },
      ],
      result: undefined,
      status: { reason: 'cancelled', type: 'incomplete' },
      toolCallId: 'p1',
      toolName: 'agent-explorer',
    });
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('brainstrike_grepSearch')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-live="true"]')).toHaveLength(0);

    // Verify the static CircleSlash icon renders for the interrupted row.
    const row = screen.getByText('brainstrike_grepSearch').closest('li');
    expect(row).not.toBeNull();
    const icon = row?.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveClass('lucide-circle-slash');
    expect(icon).not.toHaveAttribute('data-live');
  });
});
