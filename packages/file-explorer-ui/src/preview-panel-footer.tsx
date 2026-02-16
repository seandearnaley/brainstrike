import {
  Button,
  Label,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@brainstrike/ui';
import { Download, FileText } from 'lucide-react';
import { memo } from 'react';
import IncludeProjectTreeSetting from './include-project-tree-setting';
import { TokenBudgetControl } from './token-budget-control';
import { TokenMeter } from './token-meter';
import { TokenSummaryBar } from './token-summary-bar';
import type { TokenCountingState } from './use-token-counting';

export interface TokenUsageMetrics {
  budget: number;
  selectedTokens: number;
  sourceSelectedTokens: number;
  includedTreeTokens: number;
  usedTokens: number;
  treePercent: number;
  selectedPercent: number;
  usedPercent: number;
  treeLabel: string;
  remainingLabel: string;
  isOverBudget: boolean;
  rangeAdjustedFilesCount: number;
  activeRangeFilesCount: number;
}

interface PreviewPanelFooterProps {
  totalFiles: number;
  tokenCounting: TokenCountingState;
  tokenUsage: TokenUsageMetrics;
  includeProjectTree: boolean;
  projectTreeUsesViewFilters: boolean;
  useTapestryRanges: boolean;
  treeLoading?: boolean;
  /** BST-153: Number of files still being indexed (for "estimating..." state) */
  selectedTokensPendingCount?: number;
  onTokenBudgetChange?: ((budget: number) => void) | undefined;
  selectedFilesCount: number;
  onIncludeProjectTreeChange?: ((checked: boolean) => void) | undefined;
  onProjectTreeUsesViewFiltersChange?: ((checked: boolean) => void) | undefined;
  onUseTapestryRangesChange?: ((checked: boolean) => void) | undefined;
  onDownloadContext?: (() => void) | undefined;
  onCopyContext?: (() => void) | undefined;
  folderSummaryThreshold?: number;
  onFolderSummaryThresholdChange?: ((threshold: number) => void) | undefined;
}

export const PreviewPanelFooter = memo<PreviewPanelFooterProps>(
  function PreviewPanelFooterComponent(props) {
    const {
      totalFiles,
      tokenCounting,
      tokenUsage,
      includeProjectTree,
      projectTreeUsesViewFilters,
      useTapestryRanges,
      treeLoading = false,
      selectedTokensPendingCount = 0,
      onTokenBudgetChange,
      selectedFilesCount,
      onIncludeProjectTreeChange,
      onProjectTreeUsesViewFiltersChange,
      onUseTapestryRangesChange,
      onDownloadContext,
      onCopyContext,
      folderSummaryThreshold = 5,
      onFolderSummaryThresholdChange,
    } = props;

    return (
      <div className="@container flex flex-shrink-0 flex-row gap-3 border-t bg-background p-3">
        <div className="flex flex-shrink-0 items-center">
          <TokenMeter
            budget={tokenUsage.budget}
            includeTree={includeProjectTree}
            isOverBudget={tokenUsage.isOverBudget}
            selectedTokens={tokenUsage.selectedTokens}
            size="md"
            sourceSelectedTokens={tokenUsage.sourceSelectedTokens}
            treeTokens={tokenUsage.includedTreeTokens}
            usedTokens={tokenUsage.usedTokens}
            useTapestryRanges={useTapestryRanges}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-center gap-2.5">
          <div className="flex min-w-0 items-center">
            <TokenSummaryBar
              activeRangeFilesCount={tokenUsage.activeRangeFilesCount}
              budget={tokenUsage.budget}
              includeTree={includeProjectTree}
              isOverBudget={tokenUsage.isOverBudget}
              rangeAdjustedFilesCount={tokenUsage.rangeAdjustedFilesCount}
              selectedTokens={tokenUsage.selectedTokens}
              selectedTokensPendingCount={selectedTokensPendingCount}
              sourceSelectedTokens={tokenUsage.sourceSelectedTokens}
              tokenCounting={tokenCounting}
              totalFiles={totalFiles}
              treeLoading={treeLoading}
              treeTokens={tokenUsage.includedTreeTokens}
              useTapestryRanges={useTapestryRanges}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <TokenBudgetControl budget={tokenUsage.budget} onBudgetChange={onTokenBudgetChange} />

            {onIncludeProjectTreeChange && (
              <div aria-hidden className="@[450px]:block hidden h-6 w-px bg-border" />
            )}

            {onIncludeProjectTreeChange && (
              <div className="flex items-center gap-2">
                <TooltipProvider delayDuration={400}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center gap-2">
                        <IncludeProjectTreeSetting
                          checked={includeProjectTree}
                          onChange={onIncludeProjectTreeChange}
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>Include project tree in the context</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            )}

            {onProjectTreeUsesViewFiltersChange && (
              <>
                <div aria-hidden className="@[650px]:block hidden h-6 w-px bg-border" />
                <TooltipProvider delayDuration={400}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center gap-2">
                        <Switch
                          aria-label="Use filtered project tree"
                          checked={projectTreeUsesViewFilters}
                          id="project-tree-uses-view-filters"
                          onCheckedChange={onProjectTreeUsesViewFiltersChange}
                        />
                        <Label
                          className="cursor-pointer select-none text-muted-foreground text-xs"
                          htmlFor="project-tree-uses-view-filters"
                        >
                          <span className="@[750px]:inline hidden">Use Filtered Tree</span>
                          <span className="@[500px]:inline @[750px]:hidden hidden">
                            Filtered Tree
                          </span>
                        </Label>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      Toggle filtered tree output. Applies when Include Project Tree is on.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </>
            )}

            {includeProjectTree && onFolderSummaryThresholdChange && (
              <>
                <div aria-hidden className="@[650px]:block hidden h-6 w-px bg-border" />
                <div className="flex items-center gap-2">
                  <label
                    className="whitespace-nowrap text-muted-foreground text-xs"
                    htmlFor="folder-summary-threshold-footer"
                    title="Number of files shown per folder in the project tree before summarizing. Set to 0 to show all."
                  >
                    <span className="@[700px]:inline hidden">Tree detail:</span>
                    <span className="@[500px]:inline @[700px]:hidden hidden">Detail:</span>
                  </label>
                  <input
                    className="h-7 @[500px]:w-14 w-12 rounded-md border border-input bg-background px-1.5 text-center text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
                    id="folder-summary-threshold-footer"
                    min="0"
                    onChange={(e) => {
                      const value = Number.parseInt(e.target.value, 10);
                      if (!Number.isNaN(value) && value >= 0) {
                        onFolderSummaryThresholdChange(value);
                      }
                    }}
                    title="Files per folder before summarizing (0 = show all)"
                    type="number"
                    value={folderSummaryThreshold}
                  />
                </div>
              </>
            )}

            {onUseTapestryRangesChange && (
              <>
                <div aria-hidden className="@[650px]:block hidden h-6 w-px bg-border" />
                <TooltipProvider delayDuration={400}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center gap-2">
                        <Switch
                          aria-label="Use tapestry ranges in context output"
                          checked={useTapestryRanges}
                          disabled={selectedFilesCount === 0}
                          id="use-tapestry-ranges"
                          onCheckedChange={onUseTapestryRangesChange}
                        />
                        <Label
                          className="cursor-pointer select-none text-muted-foreground text-xs"
                          htmlFor="use-tapestry-ranges"
                        >
                          <span className="@[750px]:inline hidden">Use Tapestry Ranges</span>
                          <span className="@[500px]:inline @[750px]:hidden hidden">Use Ranges</span>
                        </Label>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      When enabled, export only active ranges. Turn off for full files.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </>
            )}

            <div className="@[850px]:block hidden flex-1" />

            <div className="flex flex-wrap items-center gap-2">
              <TooltipProvider delayDuration={400}>
                {onDownloadContext && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label={
                          selectedFilesCount === 0
                            ? 'Download Context (no files selected)'
                            : 'Download Context'
                        }
                        className="@[600px]:h-9 h-8 @[600px]:px-3 px-2"
                        data-testid="download-context-button"
                        disabled={selectedFilesCount === 0}
                        onClick={onDownloadContext}
                        size="sm"
                        variant="outline"
                      >
                        <Download className="@[600px]:mr-2 size-3.5" />
                        <span className="@[700px]:inline hidden">Download Context</span>
                        <span className="@[500px]:inline @[700px]:hidden hidden">Download</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Download context as file</TooltipContent>
                  </Tooltip>
                )}
                {onCopyContext && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label={
                          selectedFilesCount === 0
                            ? 'Copy Context (no files selected)'
                            : 'Copy Context'
                        }
                        className="@[600px]:h-9 h-8 @[600px]:px-3 px-2"
                        data-testid="copy-context-button"
                        disabled={selectedFilesCount === 0}
                        onClick={onCopyContext}
                        size="sm"
                        variant="outline"
                      >
                        <FileText className="@[600px]:mr-2 size-3.5" />
                        <span className="@[700px]:inline hidden">Copy Context</span>
                        <span className="@[500px]:inline @[700px]:hidden hidden">Copy</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Copy context to clipboard</TooltipContent>
                  </Tooltip>
                )}
              </TooltipProvider>
            </div>
          </div>
        </div>
      </div>
    );
  }
);

PreviewPanelFooter.displayName = 'PreviewPanelFooter';
