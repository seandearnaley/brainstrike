import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantDetailLevel } from '../assistant-detail-level';
import {
  ASSISTANT_DETAIL_LEVEL_STORAGE_KEY,
  AssistantDetailLevelProvider,
} from '../assistant-detail-level-context';
import { type SubagentCardProps, SubagentExecutionCard } from '../subagent-execution-card';
import { personaLabelForToolName } from '../subagent-persona-label';
import { type LooseProps, toolPartElement } from './tool-part-render';

function renderCard(props: LooseProps<SubagentCardProps>) {
  return render(toolPartElement(SubagentExecutionCard, props));
}

function renderCardAtDetailLevel(
  props: LooseProps<SubagentCardProps>,
  level: AssistantDetailLevel
) {
  window.localStorage.setItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY, level);
  return render(
    <AssistantDetailLevelProvider>
      {toolPartElement(SubagentExecutionCard, props)}
    </AssistantDetailLevelProvider>
  );
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

// BST-1686 finding 1 (PR #3066 review + CDT pass): `ToolFallback` gates its
// result-summary chip on `policy.showResultSummary`
// (`resolveToolDisplayPolicy`), but this card's own `· N tool calls` chip
// rendered unconditionally in `.bs-step-row-meta` — the one trailing chip on
// the delegation card the Detail control did not touch. It now reads the
// same policy every other trailing chip in the trace reads.
describe('SubagentExecutionCard detail level', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it('hides the tool-call-count chip at compact', () => {
    renderCardAtDetailLevel(
      {
        result: completedResult,
        status: { type: 'complete' },
        toolCallId: 'delegation-1',
        toolName: 'agent-explore',
      },
      'compact'
    );
    expect(screen.getByText('Explorer finished')).toBeInTheDocument();
    expect(screen.queryByText('· 2 tool calls', { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByText(/tool calls?$/)).not.toBeInTheDocument();
  });

  it('shows the tool-call-count chip at standard', () => {
    renderCardAtDetailLevel(
      {
        result: completedResult,
        status: { type: 'complete' },
        toolCallId: 'delegation-1',
        toolName: 'agent-explore',
      },
      'standard'
    );
    expect(screen.getByText('· 2 tool calls')).toBeInTheDocument();
  });
});

// BST-1686 finding 3 (PR #3066 review + CDT pass): `trailing` used to render
// INSIDE `.bs-step-row-content`, which is the `aria-labelledby` target of the
// non-interactive (`role="group"`) row form — so a zero-row delegation was
// named "Delegating to Analyst · 0 tool calls" instead of just the verb.
// Rendered at an explicit `standard` level (PR #3067 review finding 3): at
// `compact` the chip would not render at all, and the name-only assertion
// below would pass without exercising what it names — it never proves the
// chip is present-but-unnamed, only that it is absent one way or another.
describe('SubagentExecutionCard non-interactive row name', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it('names a zero-row delegation by its verb alone, without the tool-call chip folded in', () => {
    renderCardAtDetailLevel(
      {
        result: undefined,
        status: { type: 'running' },
        toolCallId: 'delegation-1',
        toolName: 'agent-analyze',
      },
      'standard'
    );
    const row = screen.getByRole('group', { name: /^Delegating to Analyst$/ });
    expect(row).toBeInTheDocument();
    // The chip is present as row text — proving "fixed" (chip renders,
    // excluded from the name) rather than "not rendered" (chip absent,
    // making the name assertion above vacuous).
    expect(row).toHaveTextContent('0 tool calls');
  });
});

it('opens the child conversation without expanding its activity rows', () => {
  const open = vi.fn();
  renderCard({
    onOpenConversation: open,
    result: completedResult,
    status: { type: 'complete' },
    toolCallId: 'delegate',
    toolName: 'agent-explore',
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open Explorer conversation' }));
  expect(open).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('brainstrike_grepSearch')).not.toBeInTheDocument();
});
