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
import { extractDroppedVaultDirectories } from '../core/drop';
import { findVaultNote } from '../core/links';
import { makeVaultNodeId, VAULT_SORT_MODES, type VaultSortMode } from '../core/types';
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

function DismissibleNotice({
  dismissLabel,
  message,
  onDismiss,
  tone,
}: {
  dismissLabel: string;
  message: string;
  onDismiss: () => void;
  tone: 'alert' | 'status';
}): React.ReactNode {
  return (
    <div
      className={`flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs ${
        tone === 'alert' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
      }`}
      role={tone}
    >
      <span className="min-w-0 flex-1 truncate">{message}</span>
      <Button
        aria-label={dismissLabel}
        className="h-5 w-5 p-0"
        onClick={onDismiss}
        size="sm"
        variant="ghost"
      >
        <X aria-hidden="true" className="h-3 w-3" />
      </Button>
    </div>
  );
}

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
      // Never scan an ungranted root: that would throw NotAllowedError and
      // trade the Reconnect affordance for a generic error row.
      if (root.status === 'ready' || root.status === 'error') {
        void state.refreshRoot(root.rootId);
      }
    }
  }, [store]);

  const handleNewNote = useCallback(() => {
    const state = store.getState();
    // Target the selected note's folder, else the first ready vault.
    const selected = state.selectedNoteId ? findVaultNote(state.roots, state.selectedNoteId) : null;
    const containerId = selected
      ? selected.pathSegments.length > 1
        ? makeVaultNodeId(selected.rootId, selected.pathSegments.slice(0, -1))
        : selected.rootId
      : state.roots.find((candidate) => candidate.status === 'ready')?.rootId;
    if (containerId) {
      void state.createNote(containerId);
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
      extraction.then(
        (result) => {
          if (result.unsupported) {
            setDropNotice('This browser cannot mount dropped folders — use Open Folder instead.');
            return;
          }
          const notices: string[] = [];
          if (result.skippedFileCount > 0) {
            notices.push('Only folders can be mounted as vaults — single files were skipped.');
          }
          if (result.failedCount > 0) {
            notices.push(
              `${result.failedCount} dropped item${result.failedCount === 1 ? '' : 's'} could not be read.`
            );
          }
          // One combined message: mounting folders must not erase the
          // skipped/failed feedback from the same drop.
          setDropNotice(notices.length > 0 ? notices.join(' ') : null);
          if (result.directories.length > 0) {
            void store.getState().addDroppedDirectories(result.directories);
          }
        },
        (error: unknown) => {
          logger.error('Reading dropped items failed', { error });
          store
            .getState()
            .reportGlobalError(
              `Could not read the dropped items: ${error instanceof Error ? error.message : String(error)}`
            );
        }
      );
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
          onClick={handleNewNote}
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
            {VAULT_SORT_MODES.map((mode) => (
              <SelectItem className="text-xs" key={mode} value={mode}>
                {SORT_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {globalError ? (
        <DismissibleNotice
          dismissLabel="Dismiss error"
          message={globalError}
          onDismiss={clearGlobalError}
          tone="alert"
        />
      ) : null}
      {dropNotice ? (
        <DismissibleNotice
          dismissLabel="Dismiss notice"
          message={dropNotice}
          onDismiss={() => setDropNotice(null)}
          tone="status"
        />
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
