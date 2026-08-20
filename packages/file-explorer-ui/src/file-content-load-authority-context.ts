import { createContext, useContext } from 'react';

export type FileContentBatchPriority = 'bulk' | 'interactive';
/** Logical caller intent; physical batch size must never choose scheduling priority. */
export type FileContentLoadIntent = 'background' | 'interactive';

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
  promoteQueuedLoad: (compositeKey: string) => Promise<void> | undefined;
  recordErrors: (
    failures: readonly {
      readonly compositeKey: string;
      readonly error: Error;
      readonly expectedGeneration: number;
    }[]
  ) => void;
  /** @internal Test-only predecessor seam; production reads are owned by scheduleBatch. */
  releaseActiveLoad: (compositeKeys: readonly string[], expectedPromise: Promise<void>) => void;
  scheduleBatch: (
    compositeKeys: readonly string[],
    task: (scheduledCompositeKeys: readonly string[]) => Promise<void>,
    priority: FileContentBatchPriority
  ) => Promise<void>;
  /**
   * Replace one consumer's complete retained-key set. Terminal errors exist
   * only while a key is actively loading or retained by at least one owner.
   */
  setRetainedErrorKeys: (owner: object, compositeKeys: readonly string[]) => void;
  subscribeErrors: (listener: () => void) => () => void;
  /** @internal Test-only predecessor seam; production reads are owned by scheduleBatch. */
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
