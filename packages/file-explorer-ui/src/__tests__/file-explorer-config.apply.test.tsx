import { Dialog } from '@brainstrike/ui';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfigDialogContent } from '../file-explorer-config';

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
          onFilterChange={onFilterChange}
          onClose={onClose}
          settings={{
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            maxSelectionCount: 10,
            includeProjectTree: true,
            folderSummaryThreshold: 5,
            devInlineFixtureEnabled: false,
          }}
          onSettingsChange={onSettingsChange}
          setMaxSelectionCount={vi.fn()}
          setUseRegex={vi.fn()}
          setFilters={vi.fn()}
          setIncludeProjectTree={vi.fn()}
          setFolderSummaryThreshold={vi.fn()}
          persistPatch={persistPatch}
          setDevInlineFixtureEnabled={vi.fn()}
          inlineFixtureSetting={{ available: true, loading: false }}
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
