import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TokenCountingState } from '../indexing/use-token-counting';
import { PreviewPanelFooter, type TokenUsageMetrics } from '../preview/preview-panel-footer';

const tokenCounting: TokenCountingState = {
  mode: 'accurate',
  loading: false,
  reason: null,
  countTokens: async () => 0,
};

function createTokenUsage(overrides: Partial<TokenUsageMetrics> = {}): TokenUsageMetrics {
  return {
    activeRangeFilesCount: 2,
    budget: 1000,
    includedTreeTokens: 250,
    isOverBudget: false,
    rangeAdjustedFilesCount: 3,
    remainingLabel: '350 left',
    selectedPercent: 40,
    selectedTokens: 400,
    sourceSelectedTokens: 500,
    treeLabel: '250 tree',
    treePercent: 25,
    usedPercent: 65,
    usedTokens: 650,
    ...overrides,
  };
}

function createProps(overrides: Partial<Parameters<typeof PreviewPanelFooter>[0]> = {}) {
  return {
    totalFiles: 12,
    tokenCounting,
    tokenUsage: createTokenUsage(),
    includeProjectTree: true,
    projectTreeUsesViewFilters: true,
    useTapestryRanges: false,
    selectedFilesCount: 4,
    onCopyContext: vi.fn(),
    onDownloadContext: vi.fn(),
    onFolderSummaryThresholdChange: vi.fn(),
    onFooterModeChange: vi.fn(),
    onIncludeProjectTreeChange: vi.fn(),
    onProjectTreeUsesViewFiltersChange: vi.fn(),
    onTokenBudgetChange: vi.fn(),
    onUseTapestryRangesChange: vi.fn(),
    ...overrides,
  } satisfies Parameters<typeof PreviewPanelFooter>[0];
}

describe('PreviewPanelFooter', () => {
  it('renders detailed controls and dispatches footer actions', async () => {
    const user = userEvent.setup();
    const props = createProps();

    render(<PreviewPanelFooter {...props} />);

    await user.click(screen.getByRole('button', { name: 'Compact summary mode' }));
    await user.click(screen.getByRole('button', { name: 'Insights summary mode' }));
    await user.click(screen.getByTestId('download-context-button'));
    await user.click(screen.getByTestId('copy-context-button'));
    await user.click(screen.getByRole('switch', { name: 'Use filtered project tree' }));
    await user.click(screen.getByRole('switch', { name: 'Use tapestry ranges in context output' }));

    const thresholdInput = screen.getByLabelText('Tree detail:');
    fireEvent.change(thresholdInput, { target: { value: '9' } });

    expect(props.onFooterModeChange).toHaveBeenCalledWith('compact');
    expect(props.onFooterModeChange).toHaveBeenCalledWith('expanded');
    expect(props.onDownloadContext).toHaveBeenCalledTimes(1);
    expect(props.onCopyContext).toHaveBeenCalledTimes(1);
    expect(props.onProjectTreeUsesViewFiltersChange).toHaveBeenCalledWith(false);
    expect(props.onUseTapestryRangesChange).toHaveBeenCalledWith(true);
    expect(props.onFolderSummaryThresholdChange).toHaveBeenLastCalledWith(9);
  });

  it('disables context actions and shows over-budget compact status with no selected files', () => {
    render(
      <PreviewPanelFooter
        {...createProps({
          footerMode: 'compact',
          selectedFilesCount: 0,
          tokenUsage: createTokenUsage({
            budget: 1000,
            isOverBudget: true,
            remainingLabel: '150 over',
            usedPercent: 115,
            usedTokens: 1150,
          }),
        })}
      />
    );

    expect(screen.getByText('150 over')).toBeInTheDocument();
    expect(screen.getByLabelText('Download Context (no files selected)')).toBeDisabled();
    expect(screen.getByLabelText('Copy Context (no files selected)')).toBeDisabled();
  });

  it('renders expanded budget composition and usage trend history', () => {
    const props = createProps({
      footerMode: 'expanded',
      tokenUsage: createTokenUsage({ usedTokens: 600, selectedTokens: 350 }),
      useTapestryRanges: true,
    });
    const { rerender } = render(<PreviewPanelFooter {...props} />);

    rerender(
      <PreviewPanelFooter
        {...props}
        tokenUsage={createTokenUsage({
          usedTokens: 700,
          selectedTokens: 450,
          includedTreeTokens: 200,
        })}
      />
    );

    expect(screen.getByText('Budget composition')).toBeInTheDocument();
    expect(screen.getByText('Usage trend')).toBeInTheDocument();
    expect(screen.getByText('Output')).toBeInTheDocument();
    expect(screen.getByText('+100')).toBeInTheDocument();
    expect(screen.getByText('700 current')).toBeInTheDocument();
    expect(screen.getByText('70% of budget')).toBeInTheDocument();
  });
});
