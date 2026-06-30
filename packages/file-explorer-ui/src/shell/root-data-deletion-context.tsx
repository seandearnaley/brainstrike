import type { DirectoryHandle } from '@brainstrike/file-system';
import { createContext, type ReactNode, useContext } from 'react';

export interface DeleteRootDataContext {
  readonly rootDirectoryHandles: readonly DirectoryHandle[];
  readonly rootIdByPath: ReadonlyMap<string, string>;
}

/**
 * Deletes a root's indexed DB rows (DELETE FROM roots → ON DELETE CASCADE to
 * file_records → file_chunks, per migration 039). MUST throw on failure —
 * the disconnect flow aborts and keeps the root connected so the user can
 * retry; a swallowed failure here would disconnect the UI while the rows
 * silently survive.
 */
export type DeleteRootData = (rootId: string, context: DeleteRootDataContext) => Promise<void>;

/**
 * Optional seam (Phase 6 cascade delete): file-explorer-ui does not own the
 * database, so the layer that does (app-shell) injects the deletion callback.
 * Absent provider = the disconnect dialog still works, but delete requests
 * fail loudly (see use-file-system-context) rather than silently no-op.
 */
const RootDataDeletionContext = createContext<DeleteRootData | null>(null);

export function RootDataDeletionProvider({
  children,
  deleteRootData,
}: {
  children: ReactNode;
  deleteRootData: DeleteRootData;
}) {
  return (
    <RootDataDeletionContext.Provider value={deleteRootData}>
      {children}
    </RootDataDeletionContext.Provider>
  );
}

export function useOptionalRootDataDeletion(): DeleteRootData | null {
  return useContext(RootDataDeletionContext);
}
