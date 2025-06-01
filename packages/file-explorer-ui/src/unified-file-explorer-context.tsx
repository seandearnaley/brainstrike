import type { DirectoryHandle } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { createContext, useContext, useMemo } from 'react';
import { useFileExplorer } from './use-file-explorer-context';

export interface UnifiedFileExplorerContextType {
  fileTree: IFileNode[];
  fileContents: { [compositeKey: string]: string };
  loadingFiles: Set<string>;
  loadFileContent: (path: string) => Promise<void>;
  handleRootDirectorySelect: () => Promise<DirectoryHandle | null>;
  isLoading: boolean;
  error: Error | null;
  rootDirectoryHandle: DirectoryHandle | null;
  isFileSystemAccessSupported: () => { supported: boolean; reason: string };
  refreshFileExplorer: () => Promise<void>;
  applyFileFilters: (
    includeFilters: string[],
    excludeFilters: string[],
    useRegex: boolean
  ) => IFileNode[];
  filterError: string | null;
  isInitialLoad: boolean;
  clearFileContents: (compositeKeys: string[]) => void;
  loadingProgress: { loaded: number; total: number; phase: 'loading' | 'counting' } | null;
  cancellable: boolean;
  cancelOperation: () => void;
  isCancelling: boolean;
}

const UnifiedFileExplorerContext = createContext<UnifiedFileExplorerContextType | null>(null);

export interface UnifiedFileExplorerProviderProps {
  children: React.ReactNode;
}

export function UnifiedFileExplorerProvider({ children }: UnifiedFileExplorerProviderProps) {
  const fileExplorerState = useFileExplorer({
    onDisplayedFilePathsChange: () => {}, // Will be overridden by individual panels if needed
  });

  const contextValue = useMemo(
    () => ({
      fileTree: fileExplorerState.fileTree,
      fileContents: fileExplorerState.fileContents,
      loadingFiles: fileExplorerState.loadingFiles,
      loadFileContent: fileExplorerState.loadFileContent,
      handleRootDirectorySelect: fileExplorerState.handleRootDirectorySelect,
      isLoading: fileExplorerState.isLoading,
      error: fileExplorerState.error,
      rootDirectoryHandle: fileExplorerState.rootDirectoryHandle,
      isFileSystemAccessSupported: fileExplorerState.isFileSystemAccessSupported,
      refreshFileExplorer: fileExplorerState.refreshFileExplorer,
      applyFileFilters: fileExplorerState.applyFileFilters,
      filterError: fileExplorerState.filterError,
      isInitialLoad: fileExplorerState.isInitialLoad,
      clearFileContents: fileExplorerState.clearFileContents,
      loadingProgress: fileExplorerState.loadingProgress,
      cancellable: fileExplorerState.cancellable,
      cancelOperation: fileExplorerState.cancelOperation,
      isCancelling: fileExplorerState.isCancelling,
    }),
    [fileExplorerState]
  );

  return (
    <UnifiedFileExplorerContext.Provider value={contextValue}>
      {children}
    </UnifiedFileExplorerContext.Provider>
  );
}

export function useUnifiedFileExplorer(): UnifiedFileExplorerContextType {
  const context = useContext(UnifiedFileExplorerContext);
  if (!context) {
    throw new Error('useUnifiedFileExplorer must be used within a UnifiedFileExplorerProvider');
  }
  return context;
}
