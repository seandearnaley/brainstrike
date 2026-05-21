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
const mockSetSelectionRules = vi.fn();
const mockClearSelectionRules = vi.fn();

vi.mock('../shell/file-explorer-provider', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shell/file-explorer-provider')>();
  const useFileExplorerStoreContext = vi.fn(() => {
    const mockStore = vi.fn((selector: (state: unknown) => unknown) =>
      selector({
        selectionModel: mockSelectionModel,
        setSelectionMode: mockSetSelectionMode,
        setSelectionRules: mockSetSelectionRules,
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

import { SelectionRulesEditor } from '../selection-rules-editor';

describe('SelectionRulesEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock to explicit mode with no rules
    mockSelectionModel.mode = 'explicit';
    mockSelectionModel.ruleSetJson = null;
    mockSelectionModel.materializedPaths = null;
  });

  describe('dialog behavior', () => {
    it('renders dialog when open', () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionRulesEditor folderId="test-folder" isOpen onOpenChange={vi.fn()} />
        </FileExplorerTestWrapper>
      );

      expect(screen.getByTestId('selection-rules-editor')).toBeInTheDocument();
      expect(screen.getByText('Selection Rules Editor')).toBeInTheDocument();
    });

    it('does not render dialog when closed', () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionRulesEditor folderId="test-folder" isOpen={false} onOpenChange={vi.fn()} />
        </FileExplorerTestWrapper>
      );

      expect(screen.queryByTestId('selection-rules-editor')).not.toBeInTheDocument();
    });

    it('calls onOpenChange when cancel is clicked', () => {
      const onOpenChange = vi.fn();

      render(
        <FileExplorerTestWrapper>
          <SelectionRulesEditor folderId="test-folder" isOpen onOpenChange={onOpenChange} />
        </FileExplorerTestWrapper>
      );

      fireEvent.click(screen.getByTestId('cancel-button'));

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe('pattern management', () => {
    it('shows empty state for include patterns initially', () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionRulesEditor folderId="test-folder" isOpen onOpenChange={vi.fn()} />
        </FileExplorerTestWrapper>
      );

      expect(
        screen.getByText('No include patterns. Add patterns to match files.')
      ).toBeInTheDocument();
    });

    it('adds include pattern when add button is clicked', async () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionRulesEditor folderId="test-folder" isOpen onOpenChange={vi.fn()} />
        </FileExplorerTestWrapper>
      );

      fireEvent.click(screen.getByTestId('add-include-pattern'));

      await waitFor(() => {
        expect(
          screen.queryByText('No include patterns. Add patterns to match files.')
        ).not.toBeInTheDocument();
      });
    });

    it('adds exclude pattern when add button is clicked', async () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionRulesEditor folderId="test-folder" isOpen onOpenChange={vi.fn()} />
        </FileExplorerTestWrapper>
      );

      fireEvent.click(screen.getByTestId('add-exclude-pattern'));

      await waitFor(() => {
        expect(
          screen.queryByText('No exclude patterns. Add patterns to filter out files.')
        ).not.toBeInTheDocument();
      });
    });

    it('adds exclude root when add button is clicked', async () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionRulesEditor folderId="test-folder" isOpen onOpenChange={vi.fn()} />
        </FileExplorerTestWrapper>
      );

      fireEvent.click(screen.getByTestId('add-exclude-root'));

      await waitFor(() => {
        expect(
          screen.queryByText('No directory exclusions. Add directories to skip.')
        ).not.toBeInTheDocument();
      });
    });
  });

  describe('default patterns', () => {
    it('applies default patterns when button is clicked', async () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionRulesEditor folderId="test-folder" isOpen onOpenChange={vi.fn()} />
        </FileExplorerTestWrapper>
      );

      fireEvent.click(screen.getByTestId('apply-defaults-button'));

      await waitFor(() => {
        // Should add default include patterns (e.g., **/*.ts)
        expect(
          screen.queryByText('No include patterns. Add patterns to match files.')
        ).not.toBeInTheDocument();
        // Should add default exclude roots (e.g., node_modules)
        expect(
          screen.queryByText('No directory exclusions. Add directories to skip.')
        ).not.toBeInTheDocument();
      });
    });
  });

  describe('applying rules', () => {
    it('calls setSelectionRules and setSelectionMode when apply is clicked with patterns', async () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionRulesEditor folderId="test-folder" isOpen onOpenChange={vi.fn()} />
        </FileExplorerTestWrapper>
      );

      // Add a pattern first
      fireEvent.click(screen.getByTestId('apply-defaults-button'));

      await waitFor(() => {
        expect(
          screen.queryByText('No include patterns. Add patterns to match files.')
        ).not.toBeInTheDocument();
      });

      // Apply rules
      fireEvent.click(screen.getByTestId('apply-rules-button'));

      await waitFor(() => {
        expect(mockSetSelectionRules).toHaveBeenCalled();
        expect(mockSetSelectionMode).toHaveBeenCalledWith('rules');
      });
    });

    it('calls clearSelectionRules when apply is clicked with no patterns', async () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionRulesEditor folderId="test-folder" isOpen onOpenChange={vi.fn()} />
        </FileExplorerTestWrapper>
      );

      // Apply without adding any patterns
      fireEvent.click(screen.getByTestId('apply-rules-button'));

      await waitFor(() => {
        expect(mockClearSelectionRules).toHaveBeenCalled();
      });
    });
  });

  describe('loading existing rules', () => {
    it('parses existing rules and displays patterns', async () => {
      const existingRuleSet = {
        version: 1,
        folderId: 'test-folder',
        rules: [
          {
            id: 'rule-1',
            type: 'glob-include',
            patterns: ['**/*.ts', '**/*.tsx'],
            enabled: true,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        metadata: {
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      mockSelectionModel.ruleSetJson = JSON.stringify(existingRuleSet);

      render(
        <FileExplorerTestWrapper>
          <SelectionRulesEditor folderId="test-folder" isOpen onOpenChange={vi.fn()} />
        </FileExplorerTestWrapper>
      );

      await waitFor(() => {
        // Should not show empty state since rules exist
        expect(
          screen.queryByText('No include patterns. Add patterns to match files.')
        ).not.toBeInTheDocument();
      });
    });

    it('exposes accessible names and titles on icon-only remove buttons', () => {
      const existingRuleSet = {
        version: 1,
        folderId: 'test-folder',
        rules: [
          {
            id: 'rule-1',
            type: 'glob-include',
            patterns: ['**/*.ts'],
            enabled: true,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
          {
            id: 'rule-2',
            type: 'root-exclude',
            roots: ['node_modules'],
            enabled: true,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
          {
            id: 'rule-3',
            type: 'glob-exclude',
            patterns: ['**/*.test.ts'],
            enabled: true,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ],
        metadata: {
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      };
      mockSelectionModel.ruleSetJson = JSON.stringify(existingRuleSet);

      render(
        <FileExplorerTestWrapper>
          <SelectionRulesEditor folderId="test-folder" isOpen onOpenChange={vi.fn()} />
        </FileExplorerTestWrapper>
      );

      expect(screen.getByRole('button', { name: 'Remove include pattern' })).toHaveAttribute(
        'title',
        'Remove include pattern'
      );
      expect(screen.getByRole('button', { name: 'Remove exclude directory' })).toHaveAttribute(
        'title',
        'Remove exclude directory'
      );
      expect(screen.getByRole('button', { name: 'Remove exclude pattern' })).toHaveAttribute(
        'title',
        'Remove exclude pattern'
      );
    });
  });

  describe('clear all rules', () => {
    it('shows clear button when rules exist and clears on click', async () => {
      render(
        <FileExplorerTestWrapper>
          <SelectionRulesEditor folderId="test-folder" isOpen onOpenChange={vi.fn()} />
        </FileExplorerTestWrapper>
      );

      // Add patterns first
      fireEvent.click(screen.getByTestId('apply-defaults-button'));

      await waitFor(() => {
        expect(screen.getByTestId('clear-all-rules')).toBeInTheDocument();
      });

      // Clear all
      fireEvent.click(screen.getByTestId('clear-all-rules'));

      await waitFor(() => {
        expect(
          screen.getByText('No include patterns. Add patterns to match files.')
        ).toBeInTheDocument();
      });
    });
  });
});
