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

type UseReportManagerProps<A = unknown> = {
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
};

const DEFAULT_REPORT_FILENAME = FileExplorerStrings.fileNames.report;

const getReportFilenameParts = (filename: string): { base: string; extension: string } => {
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex <= 0 || lastDotIndex === filename.length - 1) {
    return { base: filename, extension: 'txt' };
  }
  return {
    base: filename.slice(0, lastDotIndex),
    extension: filename.slice(lastDotIndex + 1),
  };
};

const sanitizeFilenameSegment = (value: string): string =>
  value
    .trim()
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');

const formatReportTimestamp = (date: Date): string =>
  date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace('T', '_')
    .replace(/:/g, '-');

const buildReportFilename = (
  rootDirectoryHandle: FileSystemDirectoryHandle | DirectoryHandle | null
): string => {
  const { base, extension } = getReportFilenameParts(DEFAULT_REPORT_FILENAME);
  const rootName = rootDirectoryHandle?.name
    ? sanitizeFilenameSegment(rootDirectoryHandle.name)
    : '';
  const prefix = rootName ? `${base}-${rootName}` : base;
  const timestamp = formatReportTimestamp(new Date());
  return `${prefix}-${timestamp}.${extension}`;
};

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
    const reportToast = toast({
      title: FileExplorerStrings.loading.generatingReport,
      description: FileExplorerStrings.prompts.waitForReport,
      duration: Number.POSITIVE_INFINITY,
    });

    try {
      const report = await handleGenerateReport();
      reportToast?.dismiss?.();

      if (report) {
        saveAs(
          new Blob([report], { type: 'text/plain;charset=utf-8' }),
          buildReportFilename(rootDirectoryHandle)
        );
        showToast({
          title: FileExplorerStrings.success.title,
          description: FileExplorerStrings.success.reportDownloaded,
        });
      }
    } catch (error) {
      reportToast?.dismiss?.();
      throw error;
    }
  }, [handleGenerateReport, rootDirectoryHandle, showToast, toast]);

  const handleCopyReport = useCallback(async () => {
    let reportToast: ReturnType<typeof toast> | undefined;
    reportToast = toast({
      title: FileExplorerStrings.loading.generatingReport,
      description: FileExplorerStrings.prompts.waitForReport,
      duration: Number.POSITIVE_INFINITY,
    });

    try {
      const report = await handleGenerateReport();
      if (!report) {
        return;
      }

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
