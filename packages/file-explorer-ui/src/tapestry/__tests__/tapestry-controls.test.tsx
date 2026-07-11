import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TapestryControls } from '../tapestry-controls';

describe('TapestryControls', () => {
  it('provides compact gallery scaling and code-lens controls', async () => {
    const user = userEvent.setup();
    const setLensEnabled = vi.fn();
    const setScale = vi.fn();

    render(
      <TooltipProvider>
        <TapestryControls
          activeRanges={2}
          allowOverlap={false}
          groupingConfig="none"
          lensEnabled={true}
          onGroupingChange={vi.fn()}
          onReset={vi.fn()}
          onSelectionControlsToggle={vi.fn()}
          scale={4}
          selectionControlsEnabled={true}
          setAllowOverlap={vi.fn()}
          setLensEnabled={setLensEnabled}
          setScale={setScale}
          totalFiles={3}
        />
      </TooltipProvider>
    );

    const dock = screen.getByTestId('tapestry-command-dock');
    expect(dock).toHaveTextContent('3 docs · 2 clips');
    expect(screen.queryByRole('heading', { name: 'Tapestry' })).toBeNull();

    const slider = screen.getByRole('slider', { name: 'Gallery scale' });
    expect(slider).toHaveValue('4');
    expect(slider).toHaveAttribute('aria-valuetext', '100%');
    expect(slider).toHaveClass('@max-[280px]/tapestry:hidden');
    expect(screen.getByTestId('tapestry-dock-stats')).toHaveClass('@min-[440px]/tapestry:inline');

    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    await user.click(screen.getByRole('button', { name: 'Toggle code lens' }));

    expect(setScale).toHaveBeenNthCalledWith(1, 3);
    expect(setScale).toHaveBeenNthCalledWith(2, 5);
    expect(setLensEnabled).toHaveBeenCalledWith(false);
  });

  it('moves secondary view configuration into the view-options menu', async () => {
    const user = userEvent.setup();
    const setAllowOverlap = vi.fn();
    const onGroupingChange = vi.fn();
    const onReset = vi.fn();
    const onSelectionControlsToggle = vi.fn();

    render(
      <TooltipProvider>
        <TapestryControls
          activeRanges={2}
          allowOverlap={false}
          groupingConfig="none"
          lensEnabled={true}
          onGroupingChange={onGroupingChange}
          onReset={onReset}
          onSelectionControlsToggle={onSelectionControlsToggle}
          scale={4}
          selectionControlsEnabled={true}
          setAllowOverlap={setAllowOverlap}
          setLensEnabled={vi.fn()}
          setScale={vi.fn()}
          totalFiles={3}
        />
      </TooltipProvider>
    );

    const openMenu = async () => {
      await user.click(screen.getByRole('button', { name: 'View options' }));
    };

    await openMenu();
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Allow overlapping clips' }));
    expect(setAllowOverlap).toHaveBeenCalledWith(true);

    await openMenu();
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'File selection controls' }));
    expect(onSelectionControlsToggle).toHaveBeenCalledWith(false);

    await openMenu();
    await user.click(screen.getByRole('menuitemradio', { name: 'By Directory' }));
    expect(onGroupingChange).toHaveBeenCalledWith('directory');

    await openMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Clear manual clips on this page' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
