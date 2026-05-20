import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PreviewViewToolbar } from '../preview/preview-view-toolbar';

describe('PreviewViewToolbar', () => {
  it('renders consistent icon controls and drives callbacks', async () => {
    const user = userEvent.setup();
    const onExpandAllGroups = vi.fn();
    const onCollapseAllGroups = vi.fn();
    const onGroupingChange = vi.fn();
    const onSelectionControlsToggle = vi.fn();

    render(
      <TooltipProvider>
        <PreviewViewToolbar
          additionalControls={<button type="button">Extra</button>}
          canCollapseExpandGroups={true}
          groupingConfig="none"
          onCollapseAllGroups={onCollapseAllGroups}
          onExpandAllGroups={onExpandAllGroups}
          onGroupingChange={onGroupingChange}
          onSelectionControlsToggle={onSelectionControlsToggle}
          selectionControlsEnabled={false}
        />
      </TooltipProvider>
    );

    await user.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(onExpandAllGroups).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(onCollapseAllGroups).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Toggle multi-select' }));
    expect(onSelectionControlsToggle).toHaveBeenCalledWith(true);

    await user.click(screen.getByRole('button', { name: 'Group by' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'By Directory' }));
    expect(onGroupingChange).toHaveBeenCalledWith('directory');

    expect(screen.getByRole('button', { name: 'Extra' })).toBeInTheDocument();
  });

  it('highlights active grouping and selection controls', () => {
    render(
      <TooltipProvider>
        <PreviewViewToolbar
          canCollapseExpandGroups={false}
          groupingConfig="rootFolder"
          onCollapseAllGroups={vi.fn()}
          onExpandAllGroups={vi.fn()}
          onGroupingChange={vi.fn()}
          onSelectionControlsToggle={vi.fn()}
          selectionControlsEnabled={true}
        />
      </TooltipProvider>
    );

    expect(screen.getByRole('button', { name: 'Group by' }).className).toContain('bg-accent');
    expect(screen.getByRole('button', { name: 'Toggle multi-select' }).className).toContain(
      'bg-accent'
    );
    expect(screen.queryByRole('button', { name: 'Expand all' })).not.toBeInTheDocument();
  });
});
