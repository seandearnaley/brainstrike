import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TapestryControls } from '../tapestry-controls';

describe('TapestryControls', () => {
  it('updates scale, toggles overlap, and triggers reset', () => {
    const setScale = vi.fn();
    const setAllowOverlap = vi.fn();
    const onReset = vi.fn();

    render(
      <TapestryControls
        activeRanges={2}
        allowOverlap={false}
        onReset={onReset}
        scale={4}
        setAllowOverlap={setAllowOverlap}
        setScale={setScale}
        totalFiles={3}
        totalLinesSelected={120}
      />
    );

    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '8' } });
    expect(setScale).toHaveBeenCalledWith(8);

    const overlapToggle = screen.getByLabelText('Allow Overlap');
    fireEvent.click(overlapToggle);
    expect(setAllowOverlap).toHaveBeenCalledWith(true);

    const resetButton = screen.getByRole('button', { name: /reset ranges/i });
    fireEvent.click(resetButton);
    expect(onReset).toHaveBeenCalled();
  });
});
