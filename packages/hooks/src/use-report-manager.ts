/**
 * Context Manager Hook
 *
 * This hook manages context generation and export functionality.
 * It handles generating context and exporting it in various formats.
 * Filename remains `use-report-manager.ts` during the staged report->context migration.
 */

import { createClipboardService } from '@brainstrike/context-actions';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { error as logError } from '@brainstrike/logging';
import { FileExplorerStrings } from '@brainstrike/types';
import {
  downloadBlobFile,
  formatTimestampedDownloadFilename,
  sanitizeFilenameSegment,
} from '@brainstrike/utils/browser-download';
import { useCallback } from 'react';

const clipboard = createClipboardService();

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

// Hyphenates separators for readability before the shared filename builder
// strips whatever is left outside its safe charset.
const hyphenateFilenameSegment = (value: string): string =>
  value
    .trim()
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');

// The desktop save bridge rejects whole filenames over 250 characters
// (`MAX_FILENAME_LENGTH` in apps/desktop/src/ipc-file-exports-handlers.ts);
// capping the only unbounded segment well below that keeps the name valid and
// readable regardless of how the root directory is named.
const ROOT_SEGMENT_MAX_CHARS = 64;

const buildContextFilename = (
  rootDirectoryHandle: FileSystemDirectoryHandle | DirectoryHandle | null
): string => {
  const { base, extension } = getReportFilenameParts(DEFAULT_CONTEXT_FILENAME);
  // Sanitized BEFORE the emptiness check and truncation: a root name made
  // entirely of stripped characters (e.g. CJK) must drop the segment rather
  // than leave `context--…`, and a truncation cut landing on a separator must
  // not leave a trailing hyphen.
  const rootName = rootDirectoryHandle?.name
    ? sanitizeFilenameSegment(hyphenateFilenameSegment(rootDirectoryHandle.name))
        .slice(0, ROOT_SEGMENT_MAX_CHARS)
        .replace(/[-.]+$/, '')
    : '';
  return formatTimestampedDownloadFilename({
    extension,
    generatedAt: new Date(),
    name: rootName ? `${base}-${rootName}` : base,
  });
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
          await downloadBlobFile({
            blob: new Blob([context], { type: 'text/plain;charset=utf-8' }),
            filename: buildContextFilename(rootDirectoryHandle),
          });
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
          const outcome = await clipboard.writeText(context);
          if (!outcome.ok) {
            throw new Error(outcome.error);
          }
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
