import { FileExplorerStrings } from '@brainstrike/types';
import { Dialog } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils')>();
  return {
    ...actual,
    isDevEnv: () => true,
  };
});

import { ConfigDialogContent } from '../file-explorer-config';

describe('ConfigDialogContent logging', () => {
  it('logs when inline fixture toggle persistence fails', async () => {
    const persistPatch = vi.fn().mockRejectedValue(new Error('boom'));
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mockOnSettingsChange = vi.fn();
    const mockSetters = {
      setMaxSelectionCount: vi.fn(),
      setUseRegex: vi.fn(),
      setFilters: vi.fn(),
      setIncludeProjectTree: vi.fn(),
      setFolderSummaryThreshold: vi.fn(),
      setDevInlineFixtureEnabled: vi.fn(),
    };

    render(
      <Dialog open>
        <ConfigDialogContent
          filterError={null}
          onFilterChange={vi.fn()}
          onClose={vi.fn()}
          settings={{
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            maxSelectionCount: 10,
            includeProjectTree: true,
            folderSummaryThreshold: 5,
            devInlineFixtureEnabled: false,
          }}
          onSettingsChange={mockOnSettingsChange}
          setMaxSelectionCount={mockSetters.setMaxSelectionCount}
          setUseRegex={mockSetters.setUseRegex}
          setFilters={mockSetters.setFilters}
          setIncludeProjectTree={mockSetters.setIncludeProjectTree}
          setFolderSummaryThreshold={mockSetters.setFolderSummaryThreshold}
          persistPatch={persistPatch}
          setDevInlineFixtureEnabled={mockSetters.setDevInlineFixtureEnabled}
          inlineFixtureSetting={{ available: true, loading: false }}
        />
      </Dialog>
    );

    const toggle = screen.getByRole('switch', {
      name: FileExplorerStrings.inlineFixture.settingLabel,
    });

    await userEvent.click(toggle);

    expect(persistPatch).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      'Failed to persist inline fixture toggle:',
      expect.any(Error)
    );

    consoleSpy.mockRestore();
  });
});
