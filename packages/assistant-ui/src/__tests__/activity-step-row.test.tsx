// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

  it('renders a non-interactive row when bodyId is omitted: no button, no chevron', () => {
    render(
      <StepRowHeader family="read" label="Read app.ts" state="done" target={null} verb="Read" />
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(document.querySelector('.bs-trace-glyph')).not.toBeInTheDocument();
    expect(screen.getByTestId('activity-step-row')).toBeInTheDocument();
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
});
