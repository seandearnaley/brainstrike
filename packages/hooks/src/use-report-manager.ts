/**
 * Report Manager Hook
 *
 * This hook manages report generation and export functionality.
 * It handles generating reports and exporting them in various formats.
 */

import type { DirectoryHandle } from '@brainstrike/file-system';
import { FileExplorerStrings } from '@brainstrike/types';
import { error as logError } from '@brainstrike/utils';
import { saveAs } from 'file-saver';
import { useCallback } from 'react';

interface UseReportManagerProps<A = unknown> {
  rootDirectoryHandle: FileSystemDirectoryHandle | DirectoryHandle | null;
  generateReportWithContent: () => Promise<string>;
  showToast: (props: {
    title: string;
    description: string;
    variant?: 'default' | 'destructive';
    action?: A;
  }) => void;
  toast: (props: {
    title: string;
    description: string;
    variant?: 'default' | 'destructive';
    action?: A;
    duration?: number;
  }) => { dismiss?: () => void };
}

export const useReportManager = <A = unknown>({
  rootDirectoryHandle,
  generateReportWithContent,
  showToast,
  toast,
}: UseReportManagerProps<A>) => {
  const handleGenerateReport = useCallback(async () => {
    if (!rootDirectoryHandle) {
      toast({
        title: FileExplorerStrings.error.title,
        description: FileExplorerStrings.error.noRootDirectory,
        variant: 'destructive',
      });
      return null;
    }

    try {
      const report = await generateReportWithContent();
      return report;
    } catch (error) {
      logError('Error generating report:', error);
      toast({
        title: FileExplorerStrings.error.title,
        description: FileExplorerStrings.error.reportGenerationFailed,
        variant: 'destructive',
      });
      return null;
    }
  }, [rootDirectoryHandle, generateReportWithContent, toast]);

  const handleDownloadReport = useCallback(async () => {
    const report = await handleGenerateReport();
    if (report) {
      saveAs(
        new Blob([report], { type: 'text/plain;charset=utf-8' }),
        FileExplorerStrings.fileNames.report
      );
      showToast({
        title: FileExplorerStrings.success.title,
        description: FileExplorerStrings.success.reportDownloaded,
      });
    }
  }, [handleGenerateReport, showToast]);

  const handleCopyReport = useCallback(async () => {
    let reportToast: ReturnType<typeof toast> | undefined;
    reportToast = toast({
      title: FileExplorerStrings.loading.generatingReport,
      description: FileExplorerStrings.prompts.waitForReport,
      duration: Number.POSITIVE_INFINITY,
    });

    try {
      const report = await handleGenerateReport();
      if (!report) return;

      await navigator.clipboard.writeText(report);
      reportToast?.dismiss?.();
      showToast({
        title: FileExplorerStrings.success.title,
        description: FileExplorerStrings.success.reportCopied,
      });
      return;
    } catch (error) {
      reportToast?.dismiss?.();
      showToast({
        title: FileExplorerStrings.error.title,
        description:
          error instanceof Error
            ? `${FileExplorerStrings.error.reportCopyFailed}: ${error.message}`
            : FileExplorerStrings.error.reportCopyFailed,
        variant: 'destructive',
      });
    }
  }, [handleGenerateReport, showToast, toast]);

  return {
    handleDownloadReport,
    handleCopyReport,
  };
};
