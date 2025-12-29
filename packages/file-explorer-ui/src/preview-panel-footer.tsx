import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@brainstrike/ui';
import { Download, FileText } from 'lucide-react';
import { memo } from 'react';
import IncludeProjectTreeSetting from './include-project-tree-setting';
import { TokenBudgetControl } from './token-budget-control';
import { TokenMeter } from './token-meter';
import { TokenSummaryBar } from './token-summary-bar';
import type { TokenCountingState } from './use-token-counting';

export type TokenUsageMetrics = {
  budget: number;
  selectedTokens: number;
  includedTreeTokens: number;
  usedTokens: number;
  treePercent: number;
  selectedPercent: number;
  usedPercent: number;
  treeLabel: string;
  remainingLabel: string;
  isOverBudget: boolean;
};

type PreviewPanelFooterProps = {
  totalFiles: number;
  tokenCounting: TokenCountingState;
  tokenUsage: TokenUsageMetrics;
  includeProjectTree: boolean;
  treeLoading?: boolean;
  onTokenBudgetChange?: ((budget: number) => void) | undefined;
  selectedFilesCount: number;
  onIncludeProjectTreeChange?: ((checked: boolean) => void) | undefined;
  onDownloadReport?: (() => void) | undefined;
  onCopyReport?: (() => void) | undefined;
  folderSummaryThreshold?: number;
  onFolderSummaryThresholdChange?: ((threshold: number) => void) | undefined;
};

export const PreviewPanelFooter = memo<PreviewPanelFooterProps>(
  function PreviewPanelFooterComponent(props) {
    const {
      totalFiles,
      tokenCounting,
      tokenUsage,
      includeProjectTree,
      treeLoading = false,
      onTokenBudgetChange,
      selectedFilesCount,
      onIncludeProjectTreeChange,
      onDownloadReport,
      onCopyReport,
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
            treeTokens={tokenUsage.includedTreeTokens}
            usedTokens={tokenUsage.usedTokens}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-center gap-2.5">
          <div className="flex min-w-0 items-center">
            <TokenSummaryBar
              budget={tokenUsage.budget}
              includeTree={includeProjectTree}
              isOverBudget={tokenUsage.isOverBudget}
              selectedTokens={tokenUsage.selectedTokens}
              tokenCounting={tokenCounting}
              totalFiles={totalFiles}
              treeLoading={treeLoading}
              treeTokens={tokenUsage.includedTreeTokens}
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

            <div className="@[850px]:block hidden flex-1" />

            <div className="flex flex-wrap items-center gap-2">
              <TooltipProvider delayDuration={400}>
                {onDownloadReport && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label={
                          selectedFilesCount === 0
                            ? 'Download Report (no files selected)'
                            : 'Download Report'
                        }
                        className="@[600px]:h-9 h-8 @[600px]:px-3 px-2"
                        data-testid="download-report-button"
                        disabled={selectedFilesCount === 0}
                        onClick={onDownloadReport}
                        size="sm"
                        variant="outline"
                      >
                        <Download className="@[600px]:mr-2 size-3.5" />
                        <span className="@[700px]:inline hidden">Download Report</span>
                        <span className="@[500px]:inline @[700px]:hidden hidden">Download</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Download report as file</TooltipContent>
                  </Tooltip>
                )}
                {onCopyReport && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label={
                          selectedFilesCount === 0
                            ? 'Copy Report (no files selected)'
                            : 'Copy Report'
                        }
                        className="@[600px]:h-9 h-8 @[600px]:px-3 px-2"
                        data-testid="copy-report-button"
                        disabled={selectedFilesCount === 0}
                        onClick={onCopyReport}
                        size="sm"
                        variant="outline"
                      >
                        <FileText className="@[600px]:mr-2 size-3.5" />
                        <span className="@[700px]:inline hidden">Copy Report</span>
                        <span className="@[500px]:inline @[700px]:hidden hidden">Copy</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Copy report to clipboard</TooltipContent>
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
