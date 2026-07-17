/**
 * Structural handle types for the notes vault.
 *
 * These are deliberately minimal structural subsets of the File System Access
 * API handle interfaces (FileSystemDirectoryHandle / FileSystemFileHandle) so
 * that (a) real browser handles are assignable without casts, and (b) tests
 * can provide lightweight in-memory fakes without emulating the full DOM
 * surface. The vault never persists paths — identity is the handle itself
 * plus a durable rootId (crypto.randomUUID), mirroring the workspace RootId
 * idiom.
 */

export type VaultPermissionMode = 'read' | 'readwrite';

export type VaultPermissionState = 'granted' | 'denied' | 'prompt';

export interface VaultPermissionDescriptor {
  mode: VaultPermissionMode;
}

export interface VaultWritableLike {
  close(): Promise<void>;
  write(data: string): Promise<void>;
}

export interface VaultFileHandleLike {
  createWritable(options?: { keepExistingData?: boolean }): Promise<VaultWritableLike>;
  getFile(): Promise<File>;
  isSameEntry(other: VaultHandleLike): Promise<boolean>;
  readonly kind: 'file';
  /** Rename within the same directory (Chromium FSA move(); desktop bridge rename). */
  move?(newName: string): Promise<void>;
  readonly name: string;
  /** Cheap metadata probe. Backends where getFile() is expensive (desktop
   * IPC reads full content) provide this; scans prefer it when present. */
  stat?(): Promise<{ lastModified: number; size: number }>;
}

export interface VaultDirectoryHandleLike {
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<VaultDirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<VaultFileHandleLike>;
  isSameEntry(other: VaultHandleLike): Promise<boolean>;
  readonly kind: 'directory';
  /** Rename within the same directory (desktop bridge only; web FSA cannot move directories). */
  move?(newName: string): Promise<void>;
  readonly name: string;
  queryPermission?(descriptor: VaultPermissionDescriptor): Promise<VaultPermissionState>;
  /** Remove a child entry; recursive required for non-empty folders. */
  removeEntry?(name: string, options?: { recursive?: boolean }): Promise<void>;
  requestPermission?(descriptor: VaultPermissionDescriptor): Promise<VaultPermissionState>;
  values(): AsyncIterableIterator<VaultHandleLike>;
}

export type VaultHandleLike = VaultFileHandleLike | VaultDirectoryHandleLike;

/** Durable identity for a mounted vault root (a crypto.randomUUID string). */
export type VaultRootId = string;

export interface VaultNoteNode {
  readonly handle: VaultFileHandleLike;
  readonly id: string;
  readonly lastModified: number;
  readonly name: string;
  /** Path segments relative to the vault root (includes the file name). */
  readonly pathSegments: readonly string[];
  readonly rootId: VaultRootId;
  readonly size: number;
  readonly type: 'note';
}

export interface VaultFolderNode {
  readonly children: readonly VaultTreeNode[];
  readonly handle: VaultDirectoryHandleLike;
  readonly id: string;
  /** Max lastModified across descendant notes; 0 when there are none. */
  readonly lastModified: number;
  readonly name: string;
  /** Recursive markdown note count under this folder. */
  readonly noteCount: number;
  readonly pathSegments: readonly string[];
  readonly rootId: VaultRootId;
  readonly type: 'folder';
}

export type VaultTreeNode = VaultNoteNode | VaultFolderNode;

export type VaultSortMode = 'name-asc' | 'name-desc' | 'modified-desc' | 'modified-asc';

export const VAULT_SORT_MODES: readonly VaultSortMode[] = [
  'name-asc',
  'name-desc',
  'modified-desc',
  'modified-asc',
];

/** Markdown extensions the vault treats as notes (matches the markdown viewer contract: no .mdx). */
export const VAULT_NOTE_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.mdown', '.mkd'];

export function isVaultNoteName(name: string): boolean {
  const lower = name.toLowerCase();
  return VAULT_NOTE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function makeVaultNodeId(rootId: VaultRootId, pathSegments: readonly string[]): string {
  return `${rootId}:${pathSegments.join('/')}`;
}
