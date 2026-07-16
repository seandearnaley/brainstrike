import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { FilePlus2, FolderOpen, RefreshCw, X } from 'lucide-react';
import type * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { createVaultNote } from '../core/create-note';
import { extractDroppedVaultDirectories } from '../core/drop';
import { findVaultNote, noteIdForSegments } from '../core/links';
import { getDirectoryHandleAt } from '../core/resolve';
import type { VaultSortMode } from '../core/types';
import type { NotesVaultStore } from '../store/notes-vault-store';
import { getNotesVaultStore } from '../store/singleton';
import { NoteViewer } from './note-viewer';
import { VaultTree } from './vault-tree';

const logger = createLogger('NotesVault');

/**
 * True when a drag originates from the OS and carries files/folders. Internal
 * drags (assistant-thread tabs via pragmatic-drag-and-drop, text selections)
 * advertise other types and must not arm or consume this drop zone.
 */
function dragCarriesFiles(event: React.DragEvent<HTMLElement>): boolean {
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes('Files') : false;
}

const SORT_LABELS: Record<VaultSortMode, string> = {
  'modified-asc': 'Oldest',
  'modified-desc': 'Recent',
  'name-asc': 'Name A–Z',
  'name-desc': 'Name Z–A',
};

export interface NotesVaultPanelProps {
  /** Injectable for tests; defaults to the app-wide singleton. */
  store?: NotesVaultStore;
}

/**
 * The Notes area: a File System Access-backed markdown vault. Left: sortable
 * recursive vault tree (drop a folder anywhere to mount it). Right: the
 * markdown viewer. All state is session-lived except the directory handles
 * (IndexedDB) — the filesystem itself is the source of truth.
 */
export function NotesVaultPanel({ store: storeProp }: NotesVaultPanelProps): React.ReactNode {
  const store = storeProp ?? getNotesVaultStore();
  const roots = useStore(store, (state) => state.roots);
  const initialized = useStore(store, (state) => state.initialized);
  const sortMode = useStore(store, (state) => state.sortMode);
  const setSortMode = useStore(store, (state) => state.setSortMode);
  const globalError = useStore(store, (state) => state.globalError);
  const clearGlobalError = useStore(store, (state) => state.clearGlobalError);
  const watchSupported = useStore(store, (state) => state.watchSupported);
  const [isDragOver, setIsDragOver] = useState(false);
  const [dropNotice, setDropNotice] = useState<string | null>(null);

  useEffect(() => {
    void store.getState().initialize();
  }, [store]);

  const handleOpenFolder = useCallback(() => {
    void store.getState().addVaultFromPicker();
  }, [store]);

  const handleRefreshAll = useCallback(() => {
    const state = store.getState();
    for (const root of state.roots) {
      void state.refreshRoot(root.rootId);
    }
  }, [store]);

  const handleNewNote = useCallback(async () => {
    const state = store.getState();
    const selected = state.selectedNoteId ? findVaultNote(state.roots, state.selectedNoteId) : null;
    const root = selected
      ? (state.roots.find((candidate) => candidate.rootId === selected.rootId) ?? null)
      : (state.roots.find((candidate) => candidate.status === 'ready') ?? null);
    if (!root) {
      return;
    }
    const parentSegments = selected ? selected.pathSegments.slice(0, -1) : [];
    try {
      const dir = await getDirectoryHandleAt(root.handle, parentSegments);
      const created = await createVaultNote(dir);
      await state.refreshRoot(root.rootId);
      state.selectNote(noteIdForSegments(root.rootId, [...parentSegments, created.name]));
    } catch (error) {
      logger.error('Creating note failed', { error, rootId: root.rootId });
      setDropNotice(
        `Could not create a note: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, [store]);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!dragCarriesFiles(event)) {
        // Internal drags (thread tabs, text selections) pass through untouched;
        // this surface only mounts real OS folders.
        setIsDragOver(false);
        return;
      }
      event.preventDefault();
      setIsDragOver(false);
      // Handle promises must be collected synchronously in the drop tick.
      const extraction = extractDroppedVaultDirectories(event.dataTransfer.items);
      void extraction.then((result) => {
        if (result.unsupported) {
          setDropNotice('This browser cannot mount dropped folders — use Open Folder instead.');
          return;
        }
        if (result.skippedFileCount > 0) {
          setDropNotice('Only folders can be mounted as vaults — single files were skipped.');
        }
        if (result.directories.length > 0) {
          setDropNotice(null);
          void store.getState().addDroppedDirectories(result.directories);
        }
      });
    },
    [store]
  );

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!dragCarriesFiles(event)) {
      return;
    }
    event.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget === event.target) {
      setIsDragOver(false);
    }
  }, []);

  const hasReadyRoot = roots.some((root) => root.status === 'ready');
  const showEmptyState = initialized && roots.length === 0;

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: drag-and-drop mount surface; the keyboard-accessible path is the Open Folder button.
    <section
      aria-label="Notes vault"
      className={`relative flex h-full min-h-0 flex-col bg-background ${
        isDragOver ? 'ring-2 ring-primary ring-inset' : ''
      }`}
      data-testid="notes-vault-panel"
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
        <h1 className="mr-2 font-semibold text-sm">Notes</h1>
        <Button
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={handleOpenFolder}
          size="sm"
          variant="outline"
        >
          <FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />
          Open Folder
        </Button>
        <Button
          className="h-7 gap-1.5 px-2 text-xs"
          disabled={!hasReadyRoot}
          onClick={() => {
            void handleNewNote();
          }}
          size="sm"
          variant="outline"
        >
          <FilePlus2 aria-hidden="true" className="h-3.5 w-3.5" />
          New Note
        </Button>
        {watchSupported ? null : (
          <Button
            aria-label="Refresh vaults"
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={roots.length === 0}
            onClick={handleRefreshAll}
            size="sm"
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
            Refresh
          </Button>
        )}
        <span className="flex-1" />
        <Select onValueChange={(value) => setSortMode(value as VaultSortMode)} value={sortMode}>
          <SelectTrigger aria-label="Sort notes" className="h-7 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(SORT_LABELS).map(([mode, label]) => (
              <SelectItem className="text-xs" key={mode} value={mode}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {globalError ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b bg-destructive/10 px-3 py-1.5 text-destructive text-xs"
          role="alert"
        >
          <span className="min-w-0 flex-1 truncate">{globalError}</span>
          <Button
            aria-label="Dismiss error"
            className="h-5 w-5 p-0"
            onClick={clearGlobalError}
            size="sm"
            variant="ghost"
          >
            <X aria-hidden="true" className="h-3 w-3" />
          </Button>
        </div>
      ) : null}
      {dropNotice ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b bg-muted px-3 py-1.5 text-muted-foreground text-xs"
          role="status"
        >
          <span className="min-w-0 flex-1 truncate">{dropNotice}</span>
          <Button
            aria-label="Dismiss notice"
            className="h-5 w-5 p-0"
            onClick={() => setDropNotice(null)}
            size="sm"
            variant="ghost"
          >
            <X aria-hidden="true" className="h-3 w-3" />
          </Button>
        </div>
      ) : null}

      {showEmptyState ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <FolderOpen aria-hidden="true" className="h-10 w-10 text-muted-foreground/60" />
          <div>
            <p className="font-medium text-sm">Open a folder of markdown notes</p>
            <p className="mt-1 text-muted-foreground text-xs">
              Your notes stay on disk — nothing is imported or indexed. You can also drag a folder
              anywhere onto this panel.
            </p>
          </div>
          <Button onClick={handleOpenFolder} size="sm">
            <FolderOpen aria-hidden="true" className="mr-1.5 h-4 w-4" />
            Open Folder
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="w-72 shrink-0 overflow-hidden border-r">
            <VaultTree store={store} />
          </aside>
          <main className="min-w-0 flex-1">
            <NoteViewer store={store} />
          </main>
        </div>
      )}
    </section>
  );
}
