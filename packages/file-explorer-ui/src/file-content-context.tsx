import type { IFileNode } from '@brainstrike/types';
import { createContext, useContext, useMemo, useRef } from 'react';
import { useSharedFileContentLoading } from './use-shared-file-content-loading';

interface FileContentContextType {
  fileContents: { [compositeKey: string]: string };
  isLoading: boolean;
  error: Error | null;
  handleFileContentLoading: (compositeKeys: string[]) => Promise<void>;
}

const FileContentContext = createContext<FileContentContextType | null>(null);
// Separate, optional context for prioritization queue
const FileContentPriorityContext = createContext<React.MutableRefObject<string[]> | null>(null);

export interface FileContentProviderProps {
  fileTree: IFileNode[];
  children: React.ReactNode;
}

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

  return (
    <FileContentContext.Provider value={contextValue}>
      <FileContentPriorityContext.Provider value={fileContentState.priorityQueueRef}>
        {children}
      </FileContentPriorityContext.Provider>
    </FileContentContext.Provider>
  );
}

export function useFileContentContext(): FileContentContextType {
  const context = useContext(FileContentContext);
  if (!context) {
    throw new Error('useFileContentContext must be used within a FileContentProvider');
  }
  return context;
}

// Optional hook for priority queue. Returns a safe local ref when not under provider.
export function useFileContentPriority(): React.MutableRefObject<string[]> {
  const ctx = useContext(FileContentPriorityContext);
  // Always call hooks in a consistent order
  const localRef = useRef<string[]>([]);
  return ctx ?? localRef;
}
