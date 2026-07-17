import type { VaultDirectoryHandleLike, VaultFileHandleLike } from './types';

/**
 * Folder/entry management primitives. Capability-based: backends expose
 * removeEntry/move where the platform supports them (desktop bridge: always;
 * web FSA: removeEntry + file move on Chromium, no directory move). A missing
 * capability throws an explicit error — the UI surfaces it, never degrades
 * quietly (NO SILENT FALLBACKS).
 */

function validateEntryName(name: string): void {
  if (name.trim() === '') {
    throw new Error('Name cannot be empty');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error('Name cannot contain path separators');
  }
  if (name === '.' || name === '..') {
    throw new Error('Name cannot be a relative path segment');
  }
  if (name.startsWith('.')) {
    throw new Error('Names starting with "." are hidden from the vault — pick a visible name');
  }
}

async function entryExists(parent: VaultDirectoryHandleLike, name: string): Promise<boolean> {
  try {
    await parent.getFileHandle(name);
    return true;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
      // TypeMismatchError => a directory with this name exists.
      return true;
    }
  }
  try {
    await parent.getDirectoryHandle(name);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return false;
    }
    return true;
  }
}

export async function createVaultFolder(
  parent: VaultDirectoryHandleLike,
  name: string
): Promise<void> {
  validateEntryName(name);
  if (await entryExists(parent, name)) {
    throw new Error(`"${name}" already exists here`);
  }
  await parent.getDirectoryHandle(name, { create: true });
}

export async function deleteVaultEntry(
  parent: VaultDirectoryHandleLike,
  name: string,
  kind: 'note' | 'folder'
): Promise<void> {
  if (typeof parent.removeEntry !== 'function') {
    throw new Error('This vault backend does not support deleting entries');
  }
  await parent.removeEntry(name, { recursive: kind === 'folder' });
}

export async function renameVaultEntry(
  parent: VaultDirectoryHandleLike,
  entry: VaultFileHandleLike | VaultDirectoryHandleLike,
  newName: string
): Promise<void> {
  validateEntryName(newName);
  if (newName === entry.name) {
    return;
  }
  // A case-only change resolves to the entry ITSELF on case-insensitive
  // filesystems (default macOS) — probing it would report a self-collision
  // and make letter-casing fixes impossible. move() still errors if a
  // genuinely distinct entry occupies the name.
  const isCaseOnlyRename = newName.toLowerCase() === entry.name.toLowerCase();
  if (!isCaseOnlyRename && (await entryExists(parent, newName))) {
    throw new Error(`"${newName}" already exists here`);
  }
  if (typeof entry.move !== 'function') {
    throw new Error(
      entry.kind === 'directory'
        ? 'This vault backend does not support renaming folders (use the desktop app, or rename on disk)'
        : 'This vault backend does not support renaming notes'
    );
  }
  await entry.move(newName);
}
