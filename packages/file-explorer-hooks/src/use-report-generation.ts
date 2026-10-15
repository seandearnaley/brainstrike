import type { RootDisplayInfo } from '@brainstrike/file-explorer/context-generation';
import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import { useEventCallback } from '@brainstrike/hooks';
import { useState } from 'react';

export type { RootDisplayInfo } from '@brainstrike/file-explorer/context-generation';

export interface ReportGenerationRequest {
  excludeFilters: string[];
  fileContents: Record<string, string>;
  folderSummaryThreshold: number;
  includeFilters: string[];
  includeProjectTree: boolean;
  projectTreeUsesViewFilters?: boolean;
  rootDirectoryHandle: DirectoryHandle;
  /**
   * RootId UUID → display metadata (storage v5) so `<file path>` attributes
   * render human-readable paths instead of composite selection keys.
   */
  rootDisplayInfoById?: Record<string, RootDisplayInfo>;
  selectedFiles: Set<string>;
  useRegex: boolean;
}

export interface ReportProgressEvent {
  loaded: number;
  total: number;
}

export interface ReportGenerationWorkerOptions {
  fileSystemAdapter: FileSystemAdapter;
}

export type ReportGenerator = (
  request: ReportGenerationRequest,
  onProgress?: (event: ReportProgressEvent) => void
) => Promise<string>;

export type CreateReportGenerator = (options: ReportGenerationWorkerOptions) => ReportGenerator;

export interface ContextGenerationOverrides {
  projectTreeUsesViewFilters?: boolean;
}

interface UseReportGenerationProps {
  createReportGenerator: CreateReportGenerator;
  excludeFilters: string[];
  fileContents: { [path: string]: string };
  fileSystemAdapter: FileSystemAdapter;
  folderSummaryThreshold: number;
  /**
   * Optional callback to get current file contents from state.
   * Used after loadMissingContent to get the fresh state with loaded content.
   * If not provided, the static fileContents prop is used.
   */
  getFileContents?: () => { [path: string]: string };
  /**
   * Optional callback returning RootId → display metadata at generation time
   * (storage v5) so report file paths render human-readably.
   */
  getRootDisplayInfoById?: () => Record<string, RootDisplayInfo>;
  includeFilters: string[];
  includeProjectTree: boolean;
  /**
   * Optional callback to load missing file contents before report generation.
   * When provided, the hook will load content for selected files that aren't
   * already in fileContents before generating the report.
   */
  loadMissingContent?: (compositeKeys: string[]) => Promise<void>;
  projectTreeUsesViewFilters?: boolean;
  rootDirectoryHandle: DirectoryHandle | undefined;
  selectedFiles: Set<string>;
  useRegex: boolean;
}

export function useReportGeneration({
  selectedFiles,
  fileContents,
  rootDirectoryHandle,
  fileSystemAdapter,
  createReportGenerator,
  includeFilters,
  excludeFilters,
  useRegex,
  includeProjectTree,
  projectTreeUsesViewFilters = false,
  folderSummaryThreshold,
  loadMissingContent,
  getFileContents,
  getRootDisplayInfoById,
}: UseReportGenerationProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<ReportProgressEvent | null>(null);

  // Keep callback identity stable while useEventCallback makes every invocation
  // read inputs from the latest committed render. Its commit-phase ref sync
  // preserves render purity without opening a stale-props window before passive
  // effects flush.
  const generateContextWithContent = useEventCallback(
    async (overrides?: ContextGenerationOverrides) => {
      if (!rootDirectoryHandle) {
        throw new Error('No root directory selected');
      }

      setIsGenerating(true);
      setProgress({ loaded: 0, total: 1 });
      try {
        // Load missing file contents if the loader is provided
        let finalFileContents = fileContents;
        if (loadMissingContent) {
          // Find selected files that don't have content loaded yet
          const missingKeys = Array.from(selectedFiles).filter((key) => !(key in fileContents));
          if (missingKeys.length > 0) {
            await loadMissingContent(missingKeys);
            // Get the updated file contents from state after loading
            finalFileContents = getFileContents ? getFileContents() : fileContents;
          }
        }

        const worker = createReportGenerator({ fileSystemAdapter });
        const rootDisplayInfoById = getRootDisplayInfoById?.();
        return await worker(
          {
            fileContents: finalFileContents,
            rootDirectoryHandle,
            selectedFiles,
            ...(rootDisplayInfoById ? { rootDisplayInfoById } : {}),
            excludeFilters,
            folderSummaryThreshold,
            includeFilters,
            includeProjectTree,
            // When override is undefined, use the latest persisted toggle.
            projectTreeUsesViewFilters:
              overrides?.projectTreeUsesViewFilters ?? projectTreeUsesViewFilters,
            useRegex,
          },
          (event: ReportProgressEvent) => setProgress(event)
        );
      } finally {
        setIsGenerating(false);
        setProgress(null);
      }
    }
  );

  return {
    generateContextWithContent,
    isGenerating,
    progress,
  };
}
