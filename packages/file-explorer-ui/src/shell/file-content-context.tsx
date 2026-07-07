import type { IFileNode } from '@brainstrike/types';
import { createContext, useContext, useMemo } from 'react';
import { useSharedFileContentLoading } from '../use-shared-file-content-loading';

interface FileContentContextType {
  error: Error | null;
  fileContents: { [compositeKey: string]: string };
  handleFileContentLoading: (compositeKeys: string[]) => Promise<void>;
  isLoading: boolean;
}

const FileContentContext = createContext<FileContentContextType | null>(null);

export interface FileContentProviderProps {
  children: React.ReactNode;
  fileTree: IFileNode[];
}

export function FileContentProvider({ fileTree, children }: FileContentProviderProps) {
  const fileContentState = useSharedFileContentLoading(fileTree);

  const contextValue = useMemo(
    () => ({
      error: fileContentState.error,
      fileContents: fileContentState.fileContents,
      handleFileContentLoading: fileContentState.handleFileContentLoading,
      isLoading: fileContentState.isLoading,
    }),
    [
      fileContentState.fileContents,
      fileContentState.isLoading,
      fileContentState.error,
      fileContentState.handleFileContentLoading,
    ]
  );

  return <FileContentContext.Provider value={contextValue}>{children}</FileContentContext.Provider>;
}

export function useFileContentContext(): FileContentContextType {
  const context = useContext(FileContentContext);
  if (!context) {
    throw new Error('useFileContentContext must be used within a FileContentProvider');
  }
  return context;
}
