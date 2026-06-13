/**
 * Shared file-system context (single-instance invariant).
 *
 * useFileSystemInstance owns per-instance root handle state — calling it from
 * more than one component creates handle lists that silently diverge the
 * moment a root is added mid-session. The historical bug: the sidebar's Add
 * Folder grew the explorer's instance while the background-indexing provider
 * read its OWN instance, so the indexer never saw the new root until the next
 * app launch. This provider mounts the instance exactly once; every consumer
 * reads the same value through useFileSystem().
 */

import { createContext, type ReactNode, useContext } from 'react';
import { useFileSystemInstance } from './use-file-system-context';

type FileSystemContextValue = ReturnType<typeof useFileSystemInstance>;

const FileSystemSharedContext = createContext<FileSystemContextValue | null>(null);

export function FileSystemProvider({ children }: { children: ReactNode }) {
  const value = useFileSystemInstance();
  return (
    <FileSystemSharedContext.Provider value={value}>{children}</FileSystemSharedContext.Provider>
  );
}

/**
 * Read the SHARED file-system instance. Throws without a FileSystemProvider —
 * a fallback instance here would resurrect the divergence bug this exists to
 * prevent (no silent fallbacks). Tests render inside FileSystemProvider or
 * mock this hook.
 */
export function useFileSystem(): FileSystemContextValue {
  const value = useContext(FileSystemSharedContext);
  if (value === null) {
    throw new Error(
      'useFileSystem requires a FileSystemProvider ancestor — mount it once near the app root.'
    );
  }
  return value;
}
