/**
 * Report Manager Hook
 *
 * This hook manages report generation and export functionality.
 * It handles generating reports and exporting them in various formats.
 */

import { FileExplorerStrings } from '@/components/custom/constants/file-explorer-constants';
import type { ToastActionElement } from '@/components/ui/toast';
import { saveAs } from 'file-saver';
import { useCallback } from 'react';

interface UseReportManagerProps {
  rootDirectoryHandle: FileSystemDirectoryHandle | null;
  generateReportWithContent: () => Promise<string>;
  showToast: (props: {
    title: string;
    description: string;
    variant?: 'default' | 'destructive';
    action?: ToastActionElement;
  }) => void;
  toast: (props: {
    title: string;
    description: string;
    variant?: 'default' | 'destructive';
    action?: ToastActionElement;
    duration?: number;
  }) => { dismiss?: () => void };
}

export const useReportManager = ({
  rootDirectoryHandle,
  generateReportWithContent,
  showToast,
  toast,
}: UseReportManagerProps) => {
  const handleGenerateReport = useCallback(async () => {
    if (!rootDirectoryHandle) {
      toast({
        title: FileExplorerStrings.ERROR.TITLE,
        description: FileExplorerStrings.ERROR.NO_ROOT_DIRECTORY,
        variant: 'destructive',
      });
      return null;
    }

    try {
      const report = await generateReportWithContent();
      return report;
    } catch (error) {
      console.error('Error generating report:', error);
      toast({
        title: FileExplorerStrings.ERROR.TITLE,
        description:
          error instanceof Error
            ? error.message
            : FileExplorerStrings.ERROR.REPORT_GENERATION_FAILED,
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
        FileExplorerStrings.FILE_NAMES.REPORT
      );
    }
  }, [handleGenerateReport]);

  const handleCopyReport = useCallback(async () => {
    let reportToast: ReturnType<typeof toast> | undefined;
    reportToast = toast({
      title: FileExplorerStrings.LOADING.GENERATING_REPORT,
      description: FileExplorerStrings.PROMPTS.WAIT_FOR_REPORT,
      duration: Number.POSITIVE_INFINITY,
    });

    try {
      const report = await handleGenerateReport();
      if (!report) return;

      await navigator.clipboard.writeText(report);
      reportToast?.dismiss?.();
      showToast({
        title: FileExplorerStrings.SUCCESS.TITLE,
        description: FileExplorerStrings.SUCCESS.REPORT_COPIED,
      });
      return;
    } catch (error) {
      reportToast?.dismiss?.();
      showToast({
        title: FileExplorerStrings.ERROR.TITLE,
        description:
          error instanceof Error
            ? `${FileExplorerStrings.ERROR.REPORT_COPY_FAILED}: ${error.message}`
            : FileExplorerStrings.ERROR.REPORT_COPY_FAILED,
        variant: 'destructive',
      });
    }
  }, [handleGenerateReport, showToast, toast]);

  return {
    handleDownloadReport,
    handleCopyReport,
  };
};
