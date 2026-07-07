/**
 * Context Manager Hook
 *
 * This hook manages context generation and export functionality.
 * It handles generating context and exporting it in various formats.
 * Filename remains `use-report-manager.ts` during the staged report->context migration.
 */

import type { DirectoryHandle } from '@brainstrike/file-system';
import { FileExplorerStrings } from '@brainstrike/types';
import { error as logError } from '@brainstrike/utils/logger';
import { useCallback } from 'react';

type ContextGenerator<O> = (options?: O) => Promise<string>;

interface UseReportManagerProps<A = unknown, O = unknown> {
  generateContextWithContent?: ContextGenerator<O>;
  rootDirectoryHandle: FileSystemDirectoryHandle | DirectoryHandle | null;
  toast: (props: {
    title: string;
    description: string;
    variant?: 'default' | 'destructive';
    action?: A;
    duration?: number;
  }) => { dismiss?: () => void };
}

interface UseReportManagerResult<O = unknown> {
  handleCopyContext: (options?: O) => Promise<void>;
  handleDownloadContext: (options?: O) => Promise<void>;
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
  toast,
}: UseReportManagerProps<A, O>): UseReportManagerResult<O> => {
  const handleGenerateContext = useCallback(
    async (options?: O) => {
      if (!rootDirectoryHandle) {
        toast({
          description: FileExplorerStrings.error.noRootDirectory,
          title: FileExplorerStrings.error.title,
          variant: 'destructive',
        });
        return null;
      }

      try {
        if (!generateContextWithContent) {
          throw new Error('No context generator provided');
        }
        const context = await generateContextWithContent(options);
        return context;
      } catch (error) {
        logError('Error generating context:', error);
        toast({
          description: FileExplorerStrings.error.contextGenerationFailed,
          title: FileExplorerStrings.error.title,
          variant: 'destructive',
        });
        return null;
      }
    },
    [generateContextWithContent, rootDirectoryHandle, toast]
  );

  const executeWithToast = useCallback(
    async (
      options: O | undefined,
      action: (context: string) => Promise<void>,
      successMessage: string,
      errorMessage: string
    ): Promise<void> => {
      const contextToast = toast({
        description: FileExplorerStrings.prompts.waitForContext,
        duration: Number.POSITIVE_INFINITY,
        title: FileExplorerStrings.loading.generatingContext,
      });

      try {
        const context = await handleGenerateContext(options);
        if (!context) {
          contextToast?.dismiss?.();
          return;
        }

        await action(context);
        contextToast?.dismiss?.();
        toast({
          description: successMessage,
          title: FileExplorerStrings.success.title,
        });
      } catch (error) {
        contextToast?.dismiss?.();
        toast({
          description: error instanceof Error ? `${errorMessage}: ${error.message}` : errorMessage,
          title: FileExplorerStrings.error.title,
          variant: 'destructive',
        });
      }
    },
    [handleGenerateContext, toast]
  );

  const handleDownloadContext = useCallback(
    async (options?: O): Promise<void> =>
      executeWithToast(
        options,
        async (context) => {
          const { saveAs } = await import('file-saver');
          saveAs(
            new Blob([context], { type: 'text/plain;charset=utf-8' }),
            buildContextFilename(rootDirectoryHandle)
          );
        },
        FileExplorerStrings.success.contextDownloaded,
        FileExplorerStrings.error.contextGenerationFailed
      ),
    [executeWithToast, rootDirectoryHandle]
  );

  const handleCopyContext = useCallback(
    async (options?: O): Promise<void> =>
      executeWithToast(
        options,
        async (context) => {
          await navigator.clipboard.writeText(context);
        },
        FileExplorerStrings.success.contextCopied,
        FileExplorerStrings.error.contextCopyFailed
      ),
    [executeWithToast]
  );

  return {
    handleCopyContext,
    handleDownloadContext,
  };
};
