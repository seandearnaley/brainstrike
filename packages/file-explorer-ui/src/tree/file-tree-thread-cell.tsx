/**
 * The "This thread" cell (ADR-0021): how the active thread's model received a
 * file, one mark per kind, and its signals: changed since read, and edited
 * without reading. A folder row counts the touched files under it.
 *
 * Like the metadata cells, each value subscribes to its own key, and the
 * store keeps a status's identity while it is unchanged, so a publish
 * repaints only the rows it changed. A file the thread never touched renders
 * nothing; freshness nobody checked reads "not checked", never "unchanged".
 */

import { cn } from '@brainstrike/ui';
import { EyeOff, FileDiff } from 'lucide-react';
import { memo, useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  type ExplorerThreadFileStatus,
  type ExplorerThreadFreshness,
  type ExplorerThreadKindAppearance,
  type ExplorerThreadStatusStore,
  useOptionalExplorerThreadStatus,
} from '../shell/explorer-thread-status';
import type { FileTreeRowData } from './optimized-file-tree-model';
import { useRowCompositeKey } from './use-row-composite-key';

const FRESHNESS_TEXT: Readonly<Record<ExplorerThreadFreshness, string>> = {
  changed: 'changed since read',
  checking: 'checking for changes',
  unavailable: 'could not check for changes',
  unchanged: 'unchanged since read',
  unknown: 'not checked for changes',
};

function describe(
  status: ExplorerThreadFileStatus,
  appearance: ExplorerThreadKindAppearance
): string {
  const parts = [
    status.kinds.map((kind) => appearance.label[kind]).join(', '),
    FRESHNESS_TEXT[status.freshness],
  ];
  if (status.editedWithoutRead) {
    parts.push('edited without reading');
  }
  if (status.gone) {
    parts.push('no longer in the window');
  }
  return `This thread: ${parts.join('; ')}`;
}

function FileThreadValue({
  compositeKey,
  store,
}: {
  compositeKey: string;
  store: ExplorerThreadStatusStore;
}) {
  const getSnapshot = useCallback(() => store.getFileStatus(compositeKey), [compositeKey, store]);
  const status = useSyncExternalStore(store.subscribe, getSnapshot);
  const touched = status !== undefined;
  // Only a shown row of a touched file pays for the "changed since read" read.
  useEffect(() => {
    if (!touched) {
      return;
    }
    return store.watch(compositeKey);
  }, [compositeKey, store, touched]);
  if (!status) {
    return null;
  }
  const summary = describe(status, store.appearance);
  return (
    <span
      className="inline-flex items-center gap-1"
      data-freshness={status.freshness}
      data-testid="explorer-thread-file"
      title={summary}
    >
      {/* Gone from the window: outlined rather than faded, so the mark keeps its
          full-strength colour against the row. */}
      <span aria-hidden="true" className="inline-flex items-center gap-0.5">
        {status.kinds.map((kind) => (
          <span
            className={cn(
              'size-2 rounded-[2px]',
              status.gone ? 'border border-current' : 'bg-current',
              store.appearance.colorClass[kind]
            )}
            data-gone={status.gone ? 'true' : undefined}
            key={kind}
          />
        ))}
      </span>
      {status.freshness === 'changed' ? (
        <FileDiff aria-hidden="true" className="size-3 shrink-0 text-warning" />
      ) : null}
      {status.editedWithoutRead ? (
        <EyeOff aria-hidden="true" className="size-3 shrink-0 text-destructive" />
      ) : null}
      <span className="sr-only">{summary}</span>
    </span>
  );
}

function FolderThreadValue({
  compositeKey,
  store,
}: {
  compositeKey: string;
  store: ExplorerThreadStatusStore;
}) {
  const getSnapshot = useCallback(
    () => store.getDirectoryFileCount(compositeKey),
    [compositeKey, store]
  );
  const count = useSyncExternalStore(store.subscribe, getSnapshot);
  if (!count) {
    return null;
  }
  const summary = `This thread touched ${count.toLocaleString()} ${count === 1 ? 'file' : 'files'} here`;
  return (
    <span
      className="font-mono text-muted-foreground text-xs tabular-nums"
      data-testid="explorer-thread-folder"
      title={summary}
    >
      {count.toLocaleString()}
      <span className="sr-only">{` ${summary}`}</span>
    </span>
  );
}

export const FileTreeThreadCell = memo(function FileTreeThreadCellComponent({
  rowData,
}: {
  rowData: FileTreeRowData;
}) {
  const store = useOptionalExplorerThreadStatus();
  const compositeKey = useRowCompositeKey(rowData);
  // The column exists only while a store is published; a row without an
  // identity is reported by the key hook and shows nothing here.
  if (!(store && compositeKey)) {
    return null;
  }
  if (rowData.fileNode.type === 'directory') {
    return <FolderThreadValue compositeKey={compositeKey} store={store} />;
  }
  if (rowData.fileNode.type !== 'file') {
    return null;
  }
  return <FileThreadValue compositeKey={compositeKey} store={store} />;
});
