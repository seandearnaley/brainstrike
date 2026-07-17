import {
  ActionContextMenu,
  Badge,
  Button,
  type TreeNode,
  TreeTable,
  useContextMenuTarget,
} from '@brainstrike/ui';
import { AlertTriangle, FileText, Folder, Loader2, NotebookText, RefreshCw, X } from 'lucide-react';
import type * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { buildVaultTreeRows, type VaultRootState, type VaultRowData } from '../core/rows';
import type { NotesVaultStore } from '../store/notes-vault-store';
import { noteDisplayName } from './note-display-name';
import {
  buildVaultLocalActions,
  type VaultDeleteDialogRequest,
  type VaultNameDialogRequest,
  vaultRowToTarget,
} from './vault-context-actions';
import { VaultDeleteDialog, VaultNameDialog } from './vault-entry-dialogs';

function RootRow({
  root,
  onReconnect,
  onRemove,
}: {
  root: VaultRootState;
  onReconnect: (rootId: string) => void;
  onRemove: (rootId: string) => void;
}): React.ReactNode {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <NotebookText aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
      <span className="truncate font-medium text-sm">{root.name}</span>
      {root.status === 'ready' ? (
        <Badge className="shrink-0 tabular-nums" variant="secondary">
          {root.noteCount}
        </Badge>
      ) : null}
      {root.status === 'scanning' ? (
        <Loader2 aria-label="Scanning" className="h-3.5 w-3.5 shrink-0 animate-spin" />
      ) : null}
      {root.status === 'error' ? (
        <span className="flex min-w-0 items-center gap-1 text-destructive text-xs">
          <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate" title={root.error}>
            {root.error}
          </span>
        </span>
      ) : null}
      {root.status === 'permission-required' ? (
        <>
          {root.error ? (
            <span className="truncate text-destructive text-xs" title={root.error}>
              {root.error}
            </span>
          ) : null}
          <Button
            className="h-6 shrink-0 px-2 text-xs"
            onClick={(event) => {
              event.stopPropagation();
              onReconnect(root.rootId);
            }}
            size="sm"
            variant="outline"
          >
            Reconnect
          </Button>
        </>
      ) : null}
      <span className="flex-1" />
      {root.builtIn ? null : (
        <Button
          aria-label={`Remove vault ${root.name}`}
          className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-destructive"
          onClick={(event) => {
            event.stopPropagation();
            onRemove(root.rootId);
          }}
          size="sm"
          variant="ghost"
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      )}
    </span>
  );
}

export interface VaultTreeProps {
  store: NotesVaultStore;
}

/**
 * The vault tree: shared TreeTable over the flat sorted row model from
 * buildVaultTreeRows. Sorting reorders the row array (TreeTable's sort props
 * are presentation-only by the TREEGRID contract); expansion/selection are
 * store-owned session state.
 */
export function VaultTree({ store }: VaultTreeProps): React.ReactNode {
  const roots = useStore(store, (state) => state.roots);
  const sortMode = useStore(store, (state) => state.sortMode);
  const expandedIds = useStore(store, (state) => state.expandedIds);
  const selectedNoteId = useStore(store, (state) => state.selectedNoteId);
  const toggleExpanded = useStore(store, (state) => state.toggleExpanded);
  const selectNote = useStore(store, (state) => state.selectNote);
  const reconnectRoot = useStore(store, (state) => state.reconnectRoot);
  const removeRoot = useStore(store, (state) => state.removeRoot);
  const refreshRoot = useStore(store, (state) => state.refreshRoot);

  const nodes = useMemo(() => buildVaultTreeRows(roots, sortMode), [roots, sortMode]);

  // Right-click menu: shared context-action system (ui-conventions CONTEXT
  // ACTION SYSTEM) — targets claimed synchronously on contextmenu, actions
  // are surface-local closures over the vault store, and named/destructive
  // flows stage into dialogs whose confirm performs the mutation.
  const contextMenuController = useContextMenuTarget();
  const { setTarget: setContextMenuTarget } = contextMenuController;
  const [nameDialog, setNameDialog] = useState<VaultNameDialogRequest | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<VaultDeleteDialogRequest | null>(null);
  const localActions = useMemo(
    () =>
      buildVaultLocalActions({
        openDeleteDialog: setDeleteDialog,
        openNameDialog: setNameDialog,
        store,
      }),
    [store]
  );
  const handleRowContextMenu = useCallback(
    (_nodeId: string, node: TreeNode<VaultRowData>) => {
      setContextMenuTarget(vaultRowToTarget(node.data));
    },
    [setContextMenuTarget]
  );

  const handleReconnect = useCallback(
    (rootId: string) => {
      void reconnectRoot(rootId);
    },
    [reconnectRoot]
  );

  const handleRemove = useCallback(
    (rootId: string) => {
      void removeRoot(rootId);
    },
    [removeRoot]
  );

  const columns = useMemo(
    () => [
      {
        cell: ({ node }: { node: TreeNode<VaultRowData> }) => {
          const { data } = node;
          if (data.kind === 'root') {
            return (
              <RootRow onReconnect={handleReconnect} onRemove={handleRemove} root={data.root} />
            );
          }
          if (data.kind === 'folder') {
            return (
              <span className="flex min-w-0 items-center gap-2">
                <Folder
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400"
                />
                <span className="truncate text-sm">{data.node.name}</span>
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {data.node.noteCount}
                </span>
              </span>
            );
          }
          return (
            <span className="flex min-w-0 items-center gap-2">
              <FileText aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-sm">{noteDisplayName(data.node.name)}</span>
            </span>
          );
        },
        header: 'Notes',
        id: 'note',
        reserveToggleSpace: true,
      },
    ],
    [handleReconnect, handleRemove]
  );

  const handleSelect = useCallback(
    (nodeId: string | null) => {
      if (nodeId === null) {
        return;
      }
      const row = nodes.find((node) => node.id === nodeId);
      if (!row) {
        return;
      }
      if (row.data.kind === 'note') {
        selectNote(nodeId);
        return;
      }
      if (row.data.kind === 'root' && row.data.root.status === 'error') {
        void refreshRoot(row.data.root.rootId);
      }
      toggleExpanded(nodeId);
    },
    [nodes, selectNote, toggleExpanded, refreshRoot]
  );

  return (
    <>
      <ActionContextMenu controller={contextMenuController} localActions={localActions}>
        <div className="h-full min-h-0" onContextMenuCapture={() => setContextMenuTarget(null)}>
          <TreeTable<VaultRowData>
            ariaLabel="Notes vault tree"
            ariaRole="treegrid"
            columns={columns}
            emptyState={
              <p className="flex items-center gap-2 p-3 text-muted-foreground text-sm">
                <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
                No vaults mounted
              </p>
            }
            expandedIds={expandedIds}
            maxHeight="100%"
            nodes={nodes}
            onRowContextMenu={handleRowContextMenu}
            onSelect={handleSelect}
            onToggleExpand={toggleExpanded}
            selectedId={selectedNoteId}
            selectionMode="single"
            showHeader={false}
            windowingStrategy="auto"
          />
        </div>
      </ActionContextMenu>
      <VaultNameDialog onClose={() => setNameDialog(null)} request={nameDialog} store={store} />
      <VaultDeleteDialog
        onClose={() => setDeleteDialog(null)}
        request={deleteDialog}
        store={store}
      />
    </>
  );
}
