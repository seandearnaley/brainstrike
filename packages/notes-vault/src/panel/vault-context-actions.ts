import {
  type AnyContextAction,
  type ContextTarget,
  defineContextAction,
} from '@brainstrike/context-actions';
import { FilePlus2, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import type { VaultRowData } from '../core/rows';
import type { NotesVaultStore } from '../store/notes-vault-store';

/** Row → immutable invocation snapshot (claimed synchronously on contextmenu). */
export function vaultRowToTarget(data: VaultRowData): ContextTarget {
  switch (data.kind) {
    case 'note':
      return { id: data.node.id, kind: 'vault-note', name: data.node.name };
    case 'folder':
      return { id: data.node.id, kind: 'vault-folder', name: data.node.name };
    default:
      return {
        builtIn: data.root.builtIn ?? false,
        id: data.root.rootId,
        kind: 'vault-root',
        name: data.root.name,
      };
  }
}

export interface VaultNameDialogRequest {
  /** new-folder: where the folder goes. */
  containerId?: string;
  currentName?: string;
  /** rename: the entry being renamed. */
  entryId?: string;
  entryKind?: 'note' | 'folder';
  kind: 'new-folder' | 'rename';
}

export interface VaultDeleteDialogRequest {
  entryId: string;
  entryKind: 'note' | 'folder';
  name: string;
}

export interface VaultLocalActionDeps {
  openDeleteDialog: (request: VaultDeleteDialogRequest) => void;
  /** Staged flows (ui-conventions: destructive/named actions never run from
   * the menu directly — the dialog's confirm performs the mutation). */
  openNameDialog: (request: VaultNameDialogRequest) => void;
  store: NotesVaultStore;
}

/**
 * Surface-local context actions for vault tree rows (localActions prop —
 * they close over the vault store and never enter the global registry).
 * ActionContextMenu toasts/logs failures centrally; runs only return
 * ActionOutcome.
 */
export function buildVaultLocalActions({
  store,
  openNameDialog,
  openDeleteDialog,
}: VaultLocalActionDeps): AnyContextAction[] {
  return [
    defineContextAction<'vault-folder' | 'vault-root'>({
      appliesTo: ['vault-folder', 'vault-root'],
      group: 'primary',
      icon: FilePlus2,
      id: 'vault.new-note',
      label: 'New Note',
      run: async (target) => {
        await store.getState().createNote(target.id);
        return { ok: true };
      },
    }),
    defineContextAction<'vault-folder' | 'vault-root'>({
      appliesTo: ['vault-folder', 'vault-root'],
      group: 'primary',
      icon: FolderPlus,
      id: 'vault.new-folder',
      label: 'New Folder…',
      run: (target) => {
        openNameDialog({ containerId: target.id, kind: 'new-folder' });
        return Promise.resolve({ ok: true });
      },
    }),
    defineContextAction<'vault-note' | 'vault-folder'>({
      appliesTo: ['vault-note', 'vault-folder'],
      group: 'primary',
      icon: Pencil,
      id: 'vault.rename',
      label: 'Rename…',
      run: (target) => {
        openNameDialog({
          currentName: target.name,
          entryId: target.id,
          entryKind: target.kind === 'vault-note' ? 'note' : 'folder',
          kind: 'rename',
        });
        return Promise.resolve({ ok: true });
      },
    }),
    defineContextAction<'vault-note' | 'vault-folder'>({
      appliesTo: ['vault-note', 'vault-folder'],
      group: 'danger',
      icon: Trash2,
      id: 'vault.delete',
      label: 'Delete…',
      run: (target) => {
        openDeleteDialog({
          entryId: target.id,
          entryKind: target.kind === 'vault-note' ? 'note' : 'folder',
          name: target.name,
        });
        return Promise.resolve({ ok: true });
      },
    }),
  ];
}
