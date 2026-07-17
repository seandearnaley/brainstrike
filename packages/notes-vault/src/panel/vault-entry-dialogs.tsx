import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@brainstrike/ui';
import type * as React from 'react';
import { useCallback, useState } from 'react';
import type { NotesVaultStore } from '../store/notes-vault-store';
import type { VaultDeleteDialogRequest, VaultNameDialogRequest } from './vault-context-actions';

const NOTE_EXTENSION_RE = /\.(md|markdown|mdown|mkd)$/i;

function splitNoteName(fullName: string): { base: string; extension: string } {
  const match = NOTE_EXTENSION_RE.exec(fullName);
  if (!match) {
    return { base: fullName, extension: '' };
  }
  return { base: fullName.slice(0, -match[0].length), extension: match[0] };
}

/**
 * Name-entry dialog for New Folder and Rename (staged from context-menu
 * actions — ui-conventions: the menu run only opens the dialog; the confirm
 * here performs the mutation). Notes are edited by display name; the original
 * extension is re-appended on submit. Operation failures surface through the
 * store's alert banner.
 */
export function VaultNameDialog({
  request,
  onClose,
  store,
}: {
  request: VaultNameDialogRequest | null;
  onClose: () => void;
  store: NotesVaultStore;
}): React.ReactNode {
  const open = request !== null;
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open={open}>
      <DialogContent className="sm:max-w-[440px]">
        {/* Remount per open so the input resets without effects. */}
        {request ? (
          <VaultNameDialogBody
            key={`${request.kind}:${request.entryId ?? request.containerId ?? ''}`}
            onClose={onClose}
            request={request}
            store={store}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function VaultNameDialogBody({
  request,
  onClose,
  store,
}: {
  request: VaultNameDialogRequest;
  onClose: () => void;
  store: NotesVaultStore;
}): React.ReactNode {
  const isRename = request.kind === 'rename';
  const split =
    isRename && request.entryKind === 'note'
      ? splitNoteName(request.currentName ?? '')
      : { base: request.currentName ?? '', extension: '' };
  const [value, setValue] = useState(isRename ? split.base : '');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const trimmed = value.trim();
    if (trimmed === '' || busy) {
      return;
    }
    // No try/finally: store actions never throw (failures land in the alert
    // banner via globalError) and React Compiler cannot compile a
    // TryStatement without a catch clause. A hypothetical throw skips
    // onClose, and the key-remount per open resets `busy`.
    setBusy(true);
    if (request.kind === 'new-folder' && request.containerId) {
      await store.getState().createFolder(request.containerId, trimmed);
    } else if (request.kind === 'rename' && request.entryId) {
      await store.getState().renameEntry(request.entryId, `${trimmed}${split.extension}`);
    }
    setBusy(false);
    onClose();
  }, [value, busy, request, split.extension, store, onClose]);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isRename ? `Rename ${request.entryKind}` : 'New folder'}</DialogTitle>
        <DialogDescription>
          {isRename
            ? 'The file on disk is renamed in place; links to the old name are not rewritten.'
            : 'Creates a folder inside the selected location.'}
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Label htmlFor="vault-entry-name">Name</Label>
        <Input
          autoFocus
          data-testid="vault-entry-name-input"
          id="vault-entry-name"
          onChange={(event) => setValue(event.target.value)}
          value={value}
        />
      </form>
      <DialogFooter>
        <Button onClick={onClose} type="button" variant="outline">
          Cancel
        </Button>
        <Button
          disabled={value.trim() === '' || busy}
          onClick={() => {
            void submit();
          }}
          type="button"
        >
          {isRename ? 'Rename' : 'Create'}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Destructive confirmation for Delete (desktop moves to system Trash; the
 * browser backend removes permanently). */
export function VaultDeleteDialog({
  request,
  onClose,
  store,
}: {
  request: VaultDeleteDialogRequest | null;
  onClose: () => void;
  store: NotesVaultStore;
}): React.ReactNode {
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open={request !== null}>
      <DialogContent className="sm:max-w-[440px]">
        {/* Remount per open so `busy` resets even after an aborted confirm. */}
        {request ? (
          <VaultDeleteDialogBody
            key={request.entryId}
            onClose={onClose}
            request={request}
            store={store}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function VaultDeleteDialogBody({
  request,
  onClose,
  store,
}: {
  request: VaultDeleteDialogRequest;
  onClose: () => void;
  store: NotesVaultStore;
}): React.ReactNode {
  const [busy, setBusy] = useState(false);
  const confirm = useCallback(async () => {
    if (busy) {
      return;
    }
    // No try/finally (React Compiler cannot compile TryStatement without a
    // catch clause); deleteEntry never throws — failures surface via the
    // store's alert banner — and the key-remount per open resets `busy`.
    setBusy(true);
    await store.getState().deleteEntry(request.entryId);
    setBusy(false);
    onClose();
  }, [request, busy, store, onClose]);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Delete {request.entryKind}</DialogTitle>
        <DialogDescription>
          {request.entryKind === 'folder'
            ? `"${request.name}" and every note inside it will be deleted.`
            : `"${request.name}" will be deleted.`}{' '}
          On desktop this moves to the system Trash; in the browser it cannot be undone.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button onClick={onClose} type="button" variant="outline">
          Cancel
        </Button>
        <Button
          data-testid="vault-delete-confirm"
          disabled={busy}
          onClick={() => {
            void confirm();
          }}
          type="button"
          variant="destructive"
        >
          Delete
        </Button>
      </DialogFooter>
    </>
  );
}
