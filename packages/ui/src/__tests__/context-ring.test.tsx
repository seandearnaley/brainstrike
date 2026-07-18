import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ContextRing } from '../assistant-ui-panel/context-ring.js';

const RING_SIZE = 18;
const RING_STROKE = 2.5;
const CIRCUMFERENCE = 2 * Math.PI * ((RING_SIZE - RING_STROKE) / 2);

function progressDasharray(): { arc: number; circumference: number } {
  const dasharray = screen.getByTestId('context-ring-progress').getAttribute('stroke-dasharray');
  const [arc, circumference] = (dasharray ?? '').split(' ').map(Number);
  return { arc: arc ?? Number.NaN, circumference: circumference ?? Number.NaN };
}

describe('ContextRing', () => {
  it('draws the progress arc as the percentage fraction of the circumference', () => {
    render(<ContextRing percentage={50} state="ok" />);
    const { arc, circumference } = progressDasharray();
    expect(circumference).toBeCloseTo(CIRCUMFERENCE, 5);
    expect(arc).toBeCloseTo(CIRCUMFERENCE / 2, 5);
  });

  it('clamps percentages above 100 and below 0 for display', () => {
    const { rerender } = render(<ContextRing percentage={140} state="critical" />);
    expect(progressDasharray().arc).toBeCloseTo(CIRCUMFERENCE, 5);
    rerender(<ContextRing percentage={-10} state="ok" />);
    expect(progressDasharray().arc).toBe(0);
  });

  it('carries the usage state for color styling', () => {
    const { rerender } = render(<ContextRing percentage={10} state="ok" />);
    expect(screen.getByTestId('context-ring')).toHaveAttribute('data-state', 'ok');
    expect(screen.getByTestId('context-ring-progress').getAttribute('class')).toContain(
      'text-muted-foreground'
    );
    rerender(<ContextRing percentage={80} state="warning" />);
    expect(screen.getByTestId('context-ring')).toHaveAttribute('data-state', 'warning');
    expect(screen.getByTestId('context-ring-progress').getAttribute('class')).toContain('amber');
    rerender(<ContextRing percentage={95} state="critical" />);
    expect(screen.getByTestId('context-ring')).toHaveAttribute('data-state', 'critical');
    expect(screen.getByTestId('context-ring-progress').getAttribute('class')).toContain(
      'text-destructive'
    );
  });

  it('exposes the percentage through the accessible name', () => {
    render(<ContextRing percentage={57.4} state="ok" />);
    expect(screen.getByRole('img', { name: 'Context usage 57%' })).toBeInTheDocument();
  });

  it('qualifies the accessible name when the value is an estimate', () => {
    render(<ContextRing isEstimated={true} percentage={12} state="ok" />);
    expect(screen.getByRole('img', { name: 'Context usage 12% (estimated)' })).toBeInTheDocument();
  });
});
