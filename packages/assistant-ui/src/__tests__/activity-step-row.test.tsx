// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Brain } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { ActivityStepMetaProvider } from '../activity-step-context';
import { StepRowHeader } from '../activity-step-row';

describe('StepRowHeader', () => {
  it('renders an interactive row: labelled toggle button, describedby content, sr-only tool id, chevron', () => {
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
    const button = screen.getByRole('button', { name: 'Expand details' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('data-state', 'done');

    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    if (describedBy === null) {
      throw new Error('unreachable: asserted truthy above');
    }
    const content = document.getElementById(describedBy);
    expect(content).toHaveTextContent('Read');
    expect(content).toHaveTextContent('app.ts');

    expect(screen.getByText('brainstrike.readWorkspaceFile')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Completed' })).toBeInTheDocument();
    expect(button.querySelector('.bs-trace-glyph')).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'Expand details' }));
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
});
