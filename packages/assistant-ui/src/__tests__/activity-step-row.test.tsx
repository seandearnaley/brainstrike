// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Brain } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { ActivityStepMetaProvider } from '../activity-step-context';
import { StepRowHeader } from '../activity-step-row';

describe('StepRowHeader', () => {
  it('renders an interactive row: content-named toggle button, sr-only tool id, chevron', () => {
    render(
      <StepRowHeader
        bodyId="body-1"
        expanded={false}
        family="read"
        label="Expand details"
        onToggle={() => {}}
        state="done"
        target="app.ts"
        toolName="brainstrike.readWorkspaceFile"
        verb="Read"
      />
    );
    // BST-1682 (WCAG 2.5.3 Label in Name): the visible verb and target lead
    // the name, the affordance trails it as a clause.
    const button = screen.getByRole('button', { name: 'Read app.ts, expand details' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('data-state', 'done');
    // The content IS the name now, so repeating it as a description would
    // make AT read the row twice.
    expect(button).not.toHaveAttribute('aria-describedby');

    expect(screen.getByText('brainstrike.readWorkspaceFile')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Completed' })).toBeInTheDocument();
    expect(button.querySelector('.bs-trace-glyph')).toBeInTheDocument();
    // The sr-only tool id sits inside the row but outside the content span,
    // so folding the content into the name must not drag the id in with it:
    // a speech-input user says what they SEE, and nobody sees the id. It
    // still reaches AT as `title` (the next test) and as row text.
    expect(button).toHaveTextContent('brainstrike.readWorkspaceFile');
    expect(button).toHaveAttribute('title', 'brainstrike.readWorkspaceFile');
  });

  it('carries the raw tool id as the accessible description via `title` (reviewer Important 1)', () => {
    // With `aria-describedby` no longer emitted on a content-named row, the
    // button's `title` becomes its accessible description per HTML-AAM — the
    // one place the raw id still reaches AT, on focus, without cluttering the
    // name. Mutation: drop `title` from the button and this assertion fails.
    render(
      <StepRowHeader
        bodyId="body-1"
        expanded={false}
        family="read"
        label="Expand details"
        onToggle={() => {}}
        state="done"
        target="app.ts"
        toolName="brainstrike.readWorkspaceFile"
        verb="Read"
      />
    );
    const button = screen.getByRole('button', { name: 'Read app.ts, expand details' });
    expect(button).toHaveAccessibleDescription('brainstrike.readWorkspaceFile');
  });

  it('has no accessible description when the row carries no tool id', () => {
    render(
      <StepRowHeader
        bodyId="body-1"
        expanded={false}
        family="read"
        label="Expand details"
        onToggle={() => {}}
        state="done"
        target="app.ts"
        verb="Read"
      />
    );
    const button = screen.getByRole('button', { name: 'Read app.ts, expand details' });
    expect(button).toHaveAccessibleDescription('');
  });

  it('names a targetless interactive row by its verb alone plus the affordance', () => {
    render(
      <StepRowHeader
        bodyId="rows-1"
        expanded
        family="delegate"
        label="Collapse details"
        onToggle={() => {}}
        state="done"
        target={null}
        verb="Explorer finished"
      />
    );
    // No target chip is rendered, so none may appear in the name — and the
    // trailing meta ("3 tool calls") is not the row's label.
    expect(
      screen.getByRole('button', { name: 'Explorer finished, collapse details' })
    ).toBeInTheDocument();
  });

  it('falls back to the affordance alone when the visible verb is whitespace-only (reviewer Low 4)', () => {
    // `contentAccessibleName` must stay total: a caller with no visible verb
    // (and no target) must not produce a name starting with ", " — the
    // helper falls back to `label` alone rather than joining onto nothing.
    render(
      <StepRowHeader
        bodyId="body-1"
        expanded={false}
        family="read"
        label="Expand details"
        onToggle={() => {}}
        state="done"
        target={null}
        verb="   "
      />
    );
    expect(screen.getByRole('button', { name: 'Expand details' })).toBeInTheDocument();
  });

  it('lets a row whose label already names the step opt out (the reasoning contract)', () => {
    render(
      <StepRowHeader
        bodyId="panel-1"
        controlsAlwaysMounted
        expanded={false}
        family="other"
        label="Show thinking"
        nameFromContent={false}
        onToggle={() => {}}
        state="running"
        target={null}
        verb="Thinking"
      />
    );
    // `Show thinking` / `Hide thinking` is an e2e + BST-1656 behaviour
    // contract; the opted-out row keeps `aria-describedby` so its content
    // still reaches AT.
    const button = screen.getByRole('button', { name: 'Show thinking' });
    expect(button).toHaveAccessibleName('Show thinking');
    const describedBy = button.getAttribute('aria-describedby');
    if (describedBy === null) {
      throw new Error('an opted-out row must still describe its own content');
    }
    expect(document.getElementById(describedBy)).toHaveTextContent('Thinking');
  });

  it('renders a non-interactive row when bodyId is omitted: no button, no chevron, named by its own content', () => {
    render(
      <StepRowHeader
        family="read"
        label="Read app.ts"
        state="done"
        target="src/app.ts"
        verb="Reading"
      />
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(document.querySelector('.bs-trace-glyph')).not.toBeInTheDocument();
    expect(screen.getByTestId('activity-step-row')).toBeInTheDocument();
    // Named from its own visible content (verb + target), not from `label` —
    // `label` is always "Expand details"/"Collapse details" from ToolFallback,
    // which would misname a row that cannot expand.
    expect(screen.getByRole('group', { name: /Reading.*src\/app\.ts/ })).toBeInTheDocument();
  });

  it('keeps the raw tool id out of the non-interactive row name while keeping it as text', () => {
    // The sr-only tool id lives inside the row but OUTSIDE the labelling
    // content, or a bodiless row (ToolFallback's running card) would be named
    // "Reading src/app.ts brainstrike.readWorkspaceFile".
    render(
      <StepRowHeader
        family="read"
        label="ignored"
        state="running"
        target="src/app.ts"
        toolName="brainstrike.readWorkspaceFile"
        verb="Reading"
      />
    );
    const row = screen.getByTestId('activity-step-row');
    // Anchored: the name is the verb and the target and NOTHING else. (The
    // seam between the two spans yields no whitespace in the computed name,
    // hence `\s*` rather than a literal space.)
    expect(screen.getByRole('group', { name: /^Reading\s*src\/app\.ts$/ })).toBe(row);
    expect(row).toHaveTextContent('brainstrike.readWorkspaceFile');
    expect(row).toHaveAttribute('title', 'brainstrike.readWorkspaceFile');
  });

  it('shimmers a running row outside any provider and carries exactly one live glyph', () => {
    render(
      <StepRowHeader
        family="run"
        label="Running"
        state="running"
        stepId="a"
        target={null}
        verb="Running tool"
      />
    );
    expect(screen.getByText('Running tool')).toHaveClass('bs-thinking-shimmer');
    expect(document.querySelectorAll('[data-live="true"]')).toHaveLength(1);
  });

  it('shimmers only the meta-designated last running step among siblings', () => {
    render(
      <ActivityStepMetaProvider meta={{ lastRunningId: 'b' }}>
        <StepRowHeader
          family="run"
          label="Row A"
          state="running"
          stepId="a"
          target={null}
          testId="row-a"
          verb="Running A"
        />
        <StepRowHeader
          family="run"
          label="Row B"
          state="running"
          stepId="b"
          target={null}
          testId="row-b"
          verb="Running B"
        />
      </ActivityStepMetaProvider>
    );
    expect(screen.getByText('Running A')).not.toHaveClass('bs-thinking-shimmer');
    expect(screen.getByText('Running B')).toHaveClass('bs-thinking-shimmer');
  });

  it('lets a glyph override replace the state glyph entirely', () => {
    render(
      <StepRowHeader
        family="read"
        glyph={<span data-testid="custom-glyph">custom</span>}
        label="Read"
        state="done"
        target={null}
        verb="Read"
      />
    );
    expect(screen.getByTestId('custom-glyph')).toBeInTheDocument();
    expect(document.querySelector('.bs-step-glyph')).not.toBeInTheDocument();
  });

  it('calls onToggle exactly once per click on the interactive row', () => {
    const onToggle = vi.fn();
    render(
      <StepRowHeader
        bodyId="body-1"
        expanded={false}
        family="read"
        label="Expand details"
        onToggle={onToggle}
        state="done"
        target={null}
        verb="Read"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Read, expand details' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('lets `icon` replace the family icon entirely', () => {
    const { container } = render(
      <StepRowHeader
        family="read"
        icon={Brain}
        label="Thinking"
        state="running"
        target={null}
        verb="Thinking"
      />
    );
    expect(container.querySelector('.lucide-brain')).toBeInTheDocument();
    expect(container.querySelector('.lucide-file-text')).not.toBeInTheDocument();
  });

  it('renders trailing and timing content, and lands targetTitle on the target chip title', () => {
    render(
      <StepRowHeader
        family="read"
        label="Read"
        state="done"
        target="app.ts"
        targetTitle="src/app.ts (12 lines)"
        timing={<span data-testid="timing-slot">1.2s</span>}
        trailing={<span data-testid="trailing-slot">2 files</span>}
        verb="Read"
      />
    );
    expect(screen.getByTestId('timing-slot')).toBeInTheDocument();
    expect(screen.getByTestId('trailing-slot')).toBeInTheDocument();
    expect(screen.getByText('app.ts')).toHaveAttribute('title', 'src/app.ts (12 lines)');
  });

  it('keeps trailing content out of the non-interactive row’s accessible name (BST-1686)', () => {
    // `trailing` used to render INSIDE `.bs-step-row-content`, the
    // `aria-labelledby` target of the non-interactive row — so a delegation
    // with a "· 0 tool calls" chip was named "Delegating to Explorer · 0
    // tool calls" instead of just its verb + target. `trailing` now sits
    // outside the content span, alongside the sr-only tool id, so it stays
    // visible text on the row without being folded into the row's name.
    render(
      <StepRowHeader
        family="read"
        label="ignored"
        state="done"
        target="src/app.ts"
        trailing={<span className="bs-step-row-meta">· 3 results</span>}
        verb="Read"
      />
    );
    const row = screen.getByTestId('activity-step-row');
    expect(screen.getByRole('group', { name: /^Read\s*src\/app\.ts$/ })).toBe(row);
    expect(row).toHaveTextContent('3 results');
  });

  it('omits the timing slot entirely when the caller passes no timing', () => {
    // Bot round 1, Claude Minor 7. `.bs-step-row-timing` is a flex item with
    // its own gap; rendered empty (the reasoning and task-list rows pass no
    // timing at all) it spends row width on nothing. Absent, not empty.
    const { container } = render(
      <StepRowHeader family="read" label="Read" state="done" target="app.ts" verb="Read" />
    );
    expect(container.querySelector('.bs-step-row-timing')).toBeNull();
  });
});
