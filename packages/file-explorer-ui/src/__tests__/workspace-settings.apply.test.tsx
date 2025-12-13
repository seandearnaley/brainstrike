import { Dialog } from '@brainstrike/ui';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfigDialogContent } from '../workspace-settings';

describe('ConfigDialogContent apply settings', () => {
  it('catches errors from persistPatch and still closes', async () => {
    const persistPatch = vi.fn().mockRejectedValue(new Error('boom'));
    const onSettingsChange = vi.fn();
    const onFilterChange = vi.fn();
    const onClose = vi.fn();
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <Dialog open>
        <ConfigDialogContent
          filterError="test"
          inlineFixtureSetting={{ available: true, loading: false }}
          onClose={onClose}
          onFilterChange={onFilterChange}
          onSettingsChange={onSettingsChange}
          persistPatch={persistPatch}
          setDevInlineFixtureEnabled={vi.fn()}
          setFilters={vi.fn()}
          setFolderSummaryThreshold={vi.fn()}
          setMaxSelectionCount={vi.fn()}
          settings={{
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            maxSelectionCount: 10,
            folderSummaryThreshold: 5,
            devInlineFixtureEnabled: false,
          }}
          setUseRegex={vi.fn()}
        />
      </Dialog>
    );

    const applyButton = screen.getByRole('button', { name: /Apply Settings/i });
    await userEvent.click(applyButton);

    await waitFor(() => {
      expect(persistPatch).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
