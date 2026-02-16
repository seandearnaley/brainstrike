/**
 * Context Manager Hook
 *
 * This hook manages context generation and export functionality.
 * It handles generating context and exporting it in various formats.
 * Filename remains `use-report-manager.ts` during the staged report->context migration.
 */

import type { DirectoryHandle } from '@brainstrike/file-system';
import { FileExplorerStrings } from '@brainstrike/types';
import { error as logError } from '@brainstrike/utils';
import { saveAs } from 'file-saver';
import { useCallback } from 'react';

type ContextGenerator<O> = (options?: O) => Promise<string>;

interface UseReportManagerProps<A = unknown, O = unknown> {
  rootDirectoryHandle: FileSystemDirectoryHandle | DirectoryHandle | null;
  generateContextWithContent?: ContextGenerator<O>;
  /** @deprecated Use `generateContextWithContent` instead. */
  generateReportWithContent?: ContextGenerator<O>;
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

interface UseReportManagerResult<O = unknown> {
  handleDownloadContext: (options?: O) => Promise<void>;
  handleCopyContext: (options?: O) => Promise<void>;
  /** @deprecated Use `handleDownloadContext` instead. */
  handleDownloadReport: (options?: O) => Promise<void>;
  /** @deprecated Use `handleCopyContext` instead. */
  handleCopyReport: (options?: O) => Promise<void>;
}

const DEFAULT_CONTEXT_FILENAME = FileExplorerStrings.fileNames.context;

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

const formatContextTimestamp = (date: Date): string =>
  date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace('T', '_')
    .replace(/:/g, '-');

const buildContextFilename = (
  rootDirectoryHandle: FileSystemDirectoryHandle | DirectoryHandle | null
): string => {
  const { base, extension } = getReportFilenameParts(DEFAULT_CONTEXT_FILENAME);
  const rootName = rootDirectoryHandle?.name
    ? sanitizeFilenameSegment(rootDirectoryHandle.name)
    : '';
  const prefix = rootName ? `${base}-${rootName}` : base;
  const timestamp = formatContextTimestamp(new Date());
  return `${prefix}-${timestamp}.${extension}`;
};

export const useReportManager = <A = unknown, O = unknown>({
  rootDirectoryHandle,
  generateContextWithContent,
  generateReportWithContent,
  showToast,
  toast,
}: UseReportManagerProps<A, O>): UseReportManagerResult<O> => {
  const contextGenerator = generateContextWithContent ?? generateReportWithContent;

  const handleGenerateContext = useCallback(
    async (options?: O) => {
      if (!rootDirectoryHandle) {
        toast({
          title: FileExplorerStrings.error.title,
          description: FileExplorerStrings.error.noRootDirectory,
          variant: 'destructive',
        });
        return null;
      }

      try {
        if (!contextGenerator) {
          throw new Error('No context generator provided');
        }
        const context = await contextGenerator(options);
        return context;
      } catch (error) {
        logError('Error generating context:', error);
        toast({
          title: FileExplorerStrings.error.title,
          description: FileExplorerStrings.error.contextGenerationFailed,
          variant: 'destructive',
        });
        return null;
      }
    },
    [contextGenerator, rootDirectoryHandle, toast]
  );

  const handleDownloadContext = useCallback(
    async (options?: O): Promise<void> => {
      const contextToast = toast({
        title: FileExplorerStrings.loading.generatingContext,
        description: FileExplorerStrings.prompts.waitForContext,
        duration: Number.POSITIVE_INFINITY,
      });

      try {
        const context = await handleGenerateContext(options);
        contextToast?.dismiss?.();

        if (context) {
          saveAs(
            new Blob([context], { type: 'text/plain;charset=utf-8' }),
            buildContextFilename(rootDirectoryHandle)
          );
          showToast({
            title: FileExplorerStrings.success.title,
            description: FileExplorerStrings.success.contextDownloaded,
          });
        }
      } catch (error) {
        contextToast?.dismiss?.();
        showToast({
          title: FileExplorerStrings.error.title,
          description:
            error instanceof Error
              ? `${FileExplorerStrings.error.contextGenerationFailed}: ${error.message}`
              : FileExplorerStrings.error.contextGenerationFailed,
          variant: 'destructive',
        });
      }
    },
    [handleGenerateContext, rootDirectoryHandle, showToast, toast]
  );

  const handleCopyContext = useCallback(
    async (options?: O): Promise<void> => {
      const contextToast = toast({
        title: FileExplorerStrings.loading.generatingContext,
        description: FileExplorerStrings.prompts.waitForContext,
        duration: Number.POSITIVE_INFINITY,
      });

      try {
        const context = await handleGenerateContext(options);
        if (!context) {
          contextToast?.dismiss?.();
          return;
        }

        await navigator.clipboard.writeText(context);
        contextToast?.dismiss?.();
        showToast({
          title: FileExplorerStrings.success.title,
          description: FileExplorerStrings.success.contextCopied,
        });
        return;
      } catch (error) {
        contextToast?.dismiss?.();
        showToast({
          title: FileExplorerStrings.error.title,
          description:
            error instanceof Error
              ? `${FileExplorerStrings.error.contextCopyFailed}: ${error.message}`
              : FileExplorerStrings.error.contextCopyFailed,
          variant: 'destructive',
        });
      }
    },
    [handleGenerateContext, showToast, toast]
  );

  return {
    handleDownloadContext,
    handleCopyContext,
    handleDownloadReport: handleDownloadContext,
    handleCopyReport: handleCopyContext,
  };
};
