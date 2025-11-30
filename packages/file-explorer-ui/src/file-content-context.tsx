import type { IFileNode } from '@brainstrike/types';
import { createContext, useContext, useMemo } from 'react';
import { useSharedFileContentLoading } from './use-shared-file-content-loading';

type FileContentContextType = {
  fileContents: { [compositeKey: string]: string };
  isLoading: boolean;
  error: Error | null;
  handleFileContentLoading: (compositeKeys: string[]) => Promise<void>;
};

const FileContentContext = createContext<FileContentContextType | null>(null);

export type FileContentProviderProps = {
  fileTree: IFileNode[];
  children: React.ReactNode;
};

export function FileContentProvider({ fileTree, children }: FileContentProviderProps) {
  const fileContentState = useSharedFileContentLoading(fileTree);

  const contextValue = useMemo(
    () => ({
      fileContents: fileContentState.fileContents,
      isLoading: fileContentState.isLoading,
      error: fileContentState.error,
      handleFileContentLoading: fileContentState.handleFileContentLoading,
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
