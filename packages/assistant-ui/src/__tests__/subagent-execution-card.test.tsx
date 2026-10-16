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

/**
 * The host's committed delegation results (agent-host `HostChildResult`): a
 * foreground child's settled result, and a background child's acknowledgement,
 * which proves only that the child started.
 */
const completedResult = {
  childThreadId: 'child-1',
  status: 'completed',
  text: 'Found the flag.',
};
const startedResult = {
  childThreadId: 'child-1',
  status: 'started',
  text: 'Background task started. Task ID: child-1. The tool "agent-explore" is running in the background. You will be notified when it completes.',
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
  it('uses the child color on its delegation card', () => {
    const { container } = renderCard({
      presentation: { colorId: 'orange', displayName: 'Aspen', markClassName: 'bg-orange-500' },
      result: completedResult,
      status: { type: 'complete' },
      toolCallId: 'delegation-1',
      toolName: 'agent-explore',
    });
    expect(container.querySelector('.bs-subagent-card')?.getAttribute('data-agent-color')).toBe(
      'orange'
    );
  });
  it('derives scheme accents for a family-colored delegation card', () => {
    const { container } = renderCard({
      presentation: {
        colorId: 'family:1375:540',
        displayName: 'Aspen',
        markClassName: 'bs-agent-family-mark',
      },
      result: completedResult,
      status: { type: 'complete' },
      toolCallId: 'delegation-1',
      toolName: 'agent-explore',
    });
    const card = container.querySelector('.bs-subagent-card');
    expect(card).toHaveAttribute('data-agent-color', 'family:1375:540');
    expect((card as HTMLElement).style.getPropertyValue('--agent-accent-light')).toMatch(
      /^oklch\(/
    );
  });

  // Live QA 2026-10-16: a background delegation's call returns as soon as the
  // child starts, so its card said "Explorer finished · 0 tool calls" while the
  // child was still making the 43-81 tool calls its own log records. The card
  // reads the child's committed run, never the start acknowledgement.
  it('shows a started background child as working with its live tool-call count', () => {
    renderCard({
      childRun: { status: 'running', toolCalls: 12 },
      result: startedResult,
      status: { type: 'complete' },
      toolCallId: 'delegation-1',
      toolName: 'agent-explore',
    });
    expect(screen.getByText('Explorer is working')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Running' })).toBeTruthy();
    expect(screen.getByText('· 12 tool calls')).toBeTruthy();
    expect(screen.queryByText('Explorer finished')).toBeNull();
  });

  it('shows a started child as working, with no count, until its own log is read', () => {
    renderCard({
      result: startedResult,
      status: { type: 'complete' },
      toolCallId: 'delegation-1',
      toolName: 'agent-explore',
    });
    expect(screen.getByText('Explorer is working')).toBeTruthy();
    expect(screen.queryByText('Explorer finished')).toBeNull();
    // An unread count is unknown, not zero.
    expect(screen.queryByText(/tool calls?$/)).toBeNull();
  });

  it.each([
    ['completed', 'Explorer finished', 'Completed'],
    ['stopped', 'Explorer stopped', 'Stopped'],
    ['failed', 'Explorer failed', 'Failed'],
    ['interrupted', 'Explorer failed', 'Failed'],
    ['needs-input', 'Explorer needs your input', 'Waiting for approval'],
  ] as const)(
    'names a child whose run is %s as its own conversation does',
    (child, verb, glyph) => {
      renderCard({
        childRun: { status: child, toolCalls: 43 },
        result: startedResult,
        status: { type: 'complete' },
        toolCallId: 'delegation-1',
        toolName: 'agent-explore',
      });
      expect(screen.getByText(verb)).toBeTruthy();
      expect(screen.getByRole('img', { name: glyph })).toBeTruthy();
      expect(screen.getByText('· 43 tool calls')).toBeTruthy();
    }
  );

  it('counts a single child tool call in the singular', () => {
    renderCard({
      childRun: { status: 'running', toolCalls: 1 },
      result: startedResult,
      status: { type: 'complete' },
      toolCallId: 'delegation-1',
      toolName: 'agent-explore',
    });
    expect(screen.getByText('· 1 tool call')).toBeTruthy();
  });

  it('shows a delegation that ran but never answered as "No answer", not Completed', () => {
    // BST-1410: a child that completed without writing a summary gave no
    // answer. Codex review on #3719: a background child's result stays the
    // `started` acknowledgement, so the child's own run says so.
    renderCard({
      childRun: { status: 'no-answer', toolCalls: 2 },
      result: { childThreadId: 'child-1', status: 'started', text: 'Background task started.' },
      status: { type: 'complete' },
      toolCallId: 'delegation-1',
      toolName: 'agent-explore',
    });
    // BST-1681: the verb slot names the outcome; the glyph carries the state.
    expect(screen.getByText('Explorer gave no answer')).toBeTruthy();
    expect(screen.queryByText('Explorer finished')).toBeNull();
    expect(screen.getByRole('img', { name: 'No answer' })).toBeTruthy();
    expect(screen.getByText('· 2 tool calls')).toBeTruthy();
  });

  it('says when a child’s progress cannot be read, and why, never that it is working', () => {
    // Codex review on #3719: a failed child-log subscription.
    renderCard({
      childRun: { reason: 'The agent host is not connected.', status: 'unavailable', toolCalls: 0 },
      result: { childThreadId: 'child-1', status: 'started', text: 'Background task started.' },
      status: { type: 'complete' },
      toolCallId: 'delegation-1',
      toolName: 'agent-explore',
    });
    expect(screen.getByText('Explorer’s progress is unavailable')).toBeTruthy();
    expect(screen.queryByText('Explorer is working')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('The agent host is not connected.');
  });

  it('shows a refused delegation as rejected, with no child and no count', () => {
    // BST-1751: the host refuses past its invocation limit; no child runs.
    renderCard({
      result: {
        status: 'rejected',
        text: '[Delegation Rejected] Delegation invocation limit reached (8 per original turn).',
      },
      status: { type: 'complete' },
      toolCallId: 'delegation-1',
      toolName: 'agent-explore',
    });
    expect(screen.getByText('Explorer delegation rejected')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Rejected' })).toBeTruthy();
    expect(screen.queryByText(/tool calls?$/)).toBeNull();
  });

  it('renders a completed delegation summary with the persona label and tool-call count', () => {
    renderCard({
      childRun: { status: 'completed', toolCalls: 2 },
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
    // The child's activity lives in its own conversation: nothing expands here.
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the running state before a result lands', () => {
    renderCard({
      result: undefined,
      status: { type: 'running' },
      toolCallId: 'delegation-1',
      toolName: 'agent-analyze',
    });
    expect(screen.getByText('Analyst is working')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Running' })).toBeTruthy();
    // No child yet, so no count: never "Running · 0 tool calls".
    expect(screen.queryByText(/tool calls?$/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  // Task 5 review, Important 2: `resolveDisplayStatus` mapped EVERY
  // `incomplete` status to `error`, so a delegation the user stopped read
  // "<Label> failed" under destructive chrome while the group summary — which
  // reads `toolStepStateFor` — called the same step Stopped. One step, one
  // state machine.
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

  // Task 5 fix-wave gap: the part-level `isError` flag must reach the card, or
  // a delegation the runtime flagged as errored reads "Explorer finished" here
  // while the group summary counts the same step as failed.
  it('reads a part-level isError flag as a failed delegation', () => {
    renderCard({
      isError: true,
      result: { text: 'The delegation could not start.' },
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

  it('marks the running step glyph data-live, exactly once', () => {
    const { container } = renderCard({
      childRun: { status: 'running', toolCalls: 3 },
      result: startedResult,
      status: { type: 'complete' },
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

  it('renders no data-live element once the child has finished', () => {
    const { container } = renderCard({
      childRun: { status: 'completed', toolCalls: 3 },
      result: startedResult,
      status: { type: 'complete' },
      toolCallId: 'p1',
      toolName: 'agent-explorer',
    });
    expect(container.querySelectorAll('[data-live="true"]')).toHaveLength(0);
  });
});

// BST-1686 finding 1 (PR #3066 review + CDT pass): `ToolFallback` gates its
// result-summary chip on `policy.showResultSummary`
// (`resolveToolDisplayPolicy`); this card's own `· N tool calls` chip reads the
// same policy every other trailing chip in the trace reads.
describe('SubagentExecutionCard detail level', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  const finished = {
    childRun: { status: 'completed', toolCalls: 43 },
    result: startedResult,
    status: { type: 'complete' },
    toolCallId: 'delegation-1',
    toolName: 'agent-explore',
  } as const;

  it('hides the tool-call-count chip at compact', () => {
    renderCardAtDetailLevel(finished, 'compact');
    expect(screen.getByText('Explorer finished')).toBeInTheDocument();
    expect(screen.queryByText(/tool calls?$/)).not.toBeInTheDocument();
  });

  it('shows the tool-call-count chip at standard', () => {
    renderCardAtDetailLevel(finished, 'standard');
    expect(screen.getByText('· 43 tool calls')).toBeInTheDocument();
  });
});

// BST-1686 finding 3 (PR #3066 review + CDT pass): `trailing` used to render
// INSIDE `.bs-step-row-content`, which is the `aria-labelledby` target of the
// non-interactive (`role="group"`) row form — so the delegation was named with
// its count folded in instead of just the verb. Rendered at an explicit
// `standard` level so the chip is present-but-unnamed, not merely absent.
describe('SubagentExecutionCard non-interactive row name', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it('names a delegation by its verb alone, without the tool-call chip folded in', () => {
    renderCardAtDetailLevel(
      {
        childRun: { status: 'running', toolCalls: 12 },
        result: startedResult,
        status: { type: 'complete' },
        toolCallId: 'delegation-1',
        toolName: 'agent-analyze',
      },
      'standard'
    );
    const row = screen.getByRole('group', { name: /^Analyst is working$/ });
    expect(row).toBeInTheDocument();
    expect(row).toHaveTextContent('12 tool calls');
  });
});

it('opens the child conversation from its card', () => {
  const open = vi.fn();
  renderCard({
    childRun: { status: 'completed', toolCalls: 2 },
    onOpenConversation: open,
    result: completedResult,
    status: { type: 'complete' },
    toolCallId: 'delegate',
    toolName: 'agent-explore',
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open Explorer conversation' }));
  expect(open).toHaveBeenCalledTimes(1);
});

it('keeps a conflicting conversation address visible as a card-local error', () => {
  renderCard({
    navigationError: 'Conflicting child conversation addresses.',
    result: completedResult,
    status: { type: 'complete' },
    toolCallId: 'call',
    toolName: 'agent-explore',
  });
  expect(screen.getByRole('alert')).toHaveTextContent('Conflicting child conversation addresses.');
  expect(screen.queryByRole('button', { name: /Open .* conversation/ })).not.toBeInTheDocument();
  expect(screen.getByText('Explorer finished')).toBeInTheDocument();
});

it('keeps valid child navigation available when presentation fails and offers an explicit reload', () => {
  const open = vi.fn();
  const reload = vi.fn();
  renderCard({
    onOpenConversation: open,
    onReloadPresentation: reload,
    presentationError: 'Child details could not be loaded',
    status: { type: 'complete' },
    toolCallId: 'call',
    toolName: 'agent-explore',
  });
  expect(screen.getByRole('alert').textContent).toContain('Child details could not be loaded');
  fireEvent.click(screen.getByRole('button', { name: 'Open Explorer conversation' }));
  expect(open).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Reload child details' }));
  expect(reload).toHaveBeenCalledTimes(1);
});
