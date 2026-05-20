import type { SelectionModel } from '@brainstrike/types';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExplorerTestWrapper } from './test-helpers';

// Mock the store context with proper typing
const mockSelectionModel: SelectionModel = {
  mode: 'explicit',
  explicitPaths: new Set<string>(),
  ruleSetJson: null,
  materializedPaths: null,
  materializedAt: null,
  queryDescriptor: null,
};

const mockSetSelectionMode = vi.fn();
const mockClearSelectionRules = vi.fn();

vi.mock('../shell/file-explorer-provider', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shell/file-explorer-provider')>();
  const useFileExplorerStoreContext = vi.fn(() => {
    const mockStore = vi.fn((selector: (state: unknown) => unknown) =>
      selector({
        selectionModel: mockSelectionModel,
        setSelectionMode: mockSetSelectionMode,
        clearSelectionRules: mockClearSelectionRules,
      })
    );
    return mockStore;
  });
  return {
    ...original,
    useFileExplorerStoreContext,
    useFileExplorerStoreSelector: vi.fn((selector: (state: unknown) => unknown) => {
      const store = useFileExplorerStoreContext();
      return store(selector);
    }),
  };
});

import { SelectionModeBadge } from '../selection-mode-badge';

describe('SelectionModeBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock to explicit mode
    mockSelectionModel.mode = 'explicit';
    mockSelectionModel.ruleSetJson = null;
    mockSelectionModel.materializedPaths = null;
  });

  describe('display modes', () => {
    it('displays Manual badge when in explicit mode', () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      expect(screen.getByTestId('selection-mode-badge')).toHaveTextContent('Manual');
    });

    it('displays Rules badge when in rules mode', () => {
      mockSelectionModel.mode = 'rules';

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      expect(screen.getByTestId('selection-mode-badge')).toHaveTextContent('Rules');
    });

    it('shows materialized count when in rules mode with matches', () => {
      mockSelectionModel.mode = 'rules';
      mockSelectionModel.materializedPaths = new Set(['file1.ts', 'file2.ts', 'file3.ts']);

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      expect(screen.getByTestId('selection-mode-badge')).toHaveTextContent('3');
    });
  });

  describe('popover interactions', () => {
    it('opens popover when clicked', async () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      const badge = screen.getByTestId('selection-mode-badge');
      fireEvent.click(badge);

      await waitFor(() => {
        expect(screen.getByText('Selection Settings')).toBeInTheDocument();
      });
    });

    it('schedules focus after opening the popover with requestAnimationFrame', async () => {
      const requestAnimationFrameSpy = vi
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation((callback: FrameRequestCallback) => {
          callback(0);
          return 1;
        });

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge maxSelectionCount={100} />
        </FileExplorerTestWrapper>
      );

      fireEvent.click(screen.getByTestId('selection-mode-badge'));

      await waitFor(() => {
        expect(screen.getByLabelText(/Maximum selection count input/i)).toBeInTheDocument();
      });

      expect(requestAnimationFrameSpy).toHaveBeenCalled();
      requestAnimationFrameSpy.mockRestore();
    });

    it('cancels a pending animation frame when unmounting after open', () => {
      const cancelAnimationFrameSpy = vi
        .spyOn(window, 'cancelAnimationFrame')
        .mockImplementation(() => {});
      const requestAnimationFrameSpy = vi
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation(() => 42);

      const { unmount } = render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge maxSelectionCount={100} />
        </FileExplorerTestWrapper>
      );

      fireEvent.click(screen.getByTestId('selection-mode-badge'));
      unmount();

      expect(requestAnimationFrameSpy).toHaveBeenCalled();
      expect(cancelAnimationFrameSpy).toHaveBeenCalledWith(42);

      requestAnimationFrameSpy.mockRestore();
      cancelAnimationFrameSpy.mockRestore();
    });

    it('shows Manual Selection and Rules-Based Selection options', async () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      const badge = screen.getByTestId('selection-mode-badge');
      fireEvent.click(badge);

      await waitFor(() => {
        expect(screen.getByText('Manual Selection')).toBeInTheDocument();
        expect(screen.getByText('Rules-Based Selection')).toBeInTheDocument();
      });
    });

    it('renders a settings trigger variant for compact toolbars', () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge triggerVariant="icon" />
        </FileExplorerTestWrapper>
      );

      expect(screen.getByRole('button', { name: 'Selection settings' })).toBeInTheDocument();
      expect(screen.queryByTestId('selection-mode-badge')).not.toBeInTheDocument();
    });

    it('shows max selection controls inside the settings popover', async () => {
      const onMaxSelectionCountChange = vi.fn();

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge
            maxSelectionCount={100}
            onMaxSelectionCountChange={onMaxSelectionCountChange}
            triggerVariant="icon"
          />
        </FileExplorerTestWrapper>
      );

      fireEvent.click(screen.getByRole('button', { name: 'Selection settings' }));

      await waitFor(() => {
        expect(screen.getByLabelText(/Maximum selection count input/i)).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: '5K' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '6K' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '8K' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: '6K' }));

      expect(onMaxSelectionCountChange).toHaveBeenCalledWith(6000);
    });

    it('calls setSelectionMode when switching to rules mode', async () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      const badge = screen.getByTestId('selection-mode-badge');
      fireEvent.click(badge);

      await waitFor(() => {
        expect(screen.getByText('Rules-Based Selection')).toBeInTheDocument();
      });

      const rulesButton = screen.getByText('Rules-Based Selection').closest('button');
      fireEvent.click(rulesButton!);

      expect(mockSetSelectionMode).toHaveBeenCalledWith('rules');
    });

    it('calls setSelectionMode when switching to explicit mode', async () => {
      mockSelectionModel.mode = 'rules';

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      const badge = screen.getByTestId('selection-mode-badge');
      fireEvent.click(badge);

      await waitFor(() => {
        expect(screen.getByText('Manual Selection')).toBeInTheDocument();
      });

      const manualButton = screen.getByText('Manual Selection').closest('button');
      fireEvent.click(manualButton!);

      expect(mockSetSelectionMode).toHaveBeenCalledWith('explicit');
    });
  });

  describe('rules actions', () => {
    it('shows Edit Rules button when rules exist', async () => {
      mockSelectionModel.mode = 'rules';
      mockSelectionModel.ruleSetJson = '{"schemaVersion":"1.0.0"}';

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      const badge = screen.getByTestId('selection-mode-badge');
      fireEvent.click(badge);

      await waitFor(() => {
        expect(screen.getByText('Edit Rules')).toBeInTheDocument();
      });
    });

    it('shows Create Rules button when no rules exist', async () => {
      mockSelectionModel.mode = 'rules';
      mockSelectionModel.ruleSetJson = null;

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge rulesEditorAvailable />
        </FileExplorerTestWrapper>
      );

      const badge = screen.getByTestId('selection-mode-badge');
      fireEvent.click(badge);

      await waitFor(() => {
        expect(screen.getByText('Create Rules')).toBeInTheDocument();
      });
    });

    it('shows Clear Rules button when rules exist', async () => {
      mockSelectionModel.mode = 'rules';
      mockSelectionModel.ruleSetJson = '{"schemaVersion":"1.0.0"}';

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      const badge = screen.getByTestId('selection-mode-badge');
      fireEvent.click(badge);

      await waitFor(() => {
        expect(screen.getByText('Clear Rules')).toBeInTheDocument();
      });
    });

    it('calls clearSelectionRules when Clear Rules is clicked', async () => {
      mockSelectionModel.mode = 'rules';
      mockSelectionModel.ruleSetJson = '{"schemaVersion":"1.0.0"}';

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      const badge = screen.getByTestId('selection-mode-badge');
      fireEvent.click(badge);

      await waitFor(() => {
        expect(screen.getByText('Clear Rules')).toBeInTheDocument();
      });

      const clearButton = screen.getByText('Clear Rules');
      fireEvent.click(clearButton);

      expect(mockClearSelectionRules).toHaveBeenCalled();
    });

    it('calls onOpenRulesEditor when Edit Rules is clicked', async () => {
      mockSelectionModel.mode = 'rules';
      mockSelectionModel.ruleSetJson = '{"schemaVersion":"1.0.0"}';
      const onOpenRulesEditor = vi.fn();

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge onOpenRulesEditor={onOpenRulesEditor} rulesEditorAvailable />
        </FileExplorerTestWrapper>
      );

      const badge = screen.getByTestId('selection-mode-badge');
      fireEvent.click(badge);

      await waitFor(() => {
        expect(screen.getByText('Edit Rules')).toBeInTheDocument();
      });

      const editButton = screen.getByText('Edit Rules');
      fireEvent.click(editButton);

      expect(onOpenRulesEditor).toHaveBeenCalled();
    });
  });

  describe('status display', () => {
    it('shows file count status when materialized paths exist', async () => {
      mockSelectionModel.mode = 'rules';
      mockSelectionModel.materializedPaths = new Set(['file1.ts', 'file2.ts', 'file3.ts']);

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      const badge = screen.getByTestId('selection-mode-badge');
      fireEvent.click(badge);

      await waitFor(() => {
        expect(screen.getByText(/3 files selected by current rules/)).toBeInTheDocument();
      });
    });

    it('uses singular "file" when only one file matched', async () => {
      mockSelectionModel.mode = 'rules';
      mockSelectionModel.materializedPaths = new Set(['file1.ts']);

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      const badge = screen.getByTestId('selection-mode-badge');
      fireEvent.click(badge);

      await waitFor(() => {
        expect(screen.getByText(/1 file selected by current rules/)).toBeInTheDocument();
      });
    });
  });

  describe('accessibility', () => {
    it('has correct aria-label for badge', () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      const badge = screen.getByTestId('selection-mode-badge');
      expect(badge).toBeInTheDocument();
    });

    it('renders with outline variant when in explicit mode', () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      const badge = screen.getByTestId('selection-mode-badge');
      // outline variant should not have primary background
      expect(badge.className).not.toMatch(/bg-primary/);
    });

    it('renders with default variant when in rules mode', () => {
      mockSelectionModel.mode = 'rules';

      render(
        <FileExplorerTestWrapper>
          <SelectionModeBadge />
        </FileExplorerTestWrapper>
      );

      const badge = screen.getByTestId('selection-mode-badge');
      // default variant should have primary styling
      expect(badge).toBeInTheDocument();
    });
  });
});
