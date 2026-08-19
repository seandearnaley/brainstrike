import { createContext, useContext } from 'react';

export interface FileContentLoadAuthority {
  beginReload: (compositeKeys: readonly string[]) => ReadonlyMap<string, number>;
  clearErrors: (compositeKeys: readonly string[]) => void;
  clearGeneration: (compositeKey: string, expectedGeneration: number | undefined) => void;
  currentGeneration: (compositeKey: string) => number;
  getActiveLoad: (compositeKey: string) => Promise<void> | undefined;
  getErrorsSnapshot: () => ReadonlyMap<string, Error>;
  invalidateAll: () => void;
  isCurrentGeneration: (compositeKey: string, expectedGeneration: number) => boolean;
  lifecycleId: number;
  recordErrors: (
    failures: readonly {
      readonly compositeKey: string;
      readonly error: Error;
      readonly expectedGeneration: number;
    }[]
  ) => void;
  releaseActiveLoad: (compositeKeys: readonly string[], expectedPromise: Promise<void>) => void;
  runBatch: (task: () => Promise<void>) => Promise<void>;
  subscribeErrors: (listener: () => void) => () => void;
  trackActiveLoad: (compositeKeys: readonly string[], promise: Promise<void>) => void;
}

export const FileContentLoadAuthorityContext = createContext<FileContentLoadAuthority | null>(null);

export function useFileContentLoadAuthority(): FileContentLoadAuthority {
  const context = useContext(FileContentLoadAuthorityContext);
  if (!context) {
    throw new Error('useFileContentLoadAuthority must be used within a FileExplorerProvider');
  }
  return context;
}
