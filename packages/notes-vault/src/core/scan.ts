import {
  isVaultNoteName,
  makeVaultNodeId,
  type VaultDirectoryHandleLike,
  type VaultFileHandleLike,
  type VaultRootId,
  type VaultTreeNode,
} from './types';

export interface VaultScanOptions {
  signal?: AbortSignal;
}

export interface VaultScanResult {
  nodes: VaultTreeNode[];
  noteCount: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('Vault scan aborted', 'AbortError');
  }
}

function isHiddenName(name: string): boolean {
  return name.startsWith('.');
}

async function scanNote(
  handle: VaultFileHandleLike,
  rootId: VaultRootId,
  pathSegments: readonly string[]
): Promise<VaultTreeNode> {
  const file = await handle.getFile();
  return {
    handle,
    id: makeVaultNodeId(rootId, pathSegments),
    lastModified: file.lastModified,
    name: handle.name,
    pathSegments,
    rootId,
    size: file.size,
    type: 'note',
  };
}

interface FolderScan {
  children: VaultTreeNode[];
  lastModified: number;
  noteCount: number;
}

async function scanFolder(
  handle: VaultDirectoryHandleLike,
  rootId: VaultRootId,
  parentSegments: readonly string[],
  options: VaultScanOptions
): Promise<FolderScan> {
  const children: VaultTreeNode[] = [];
  let noteCount = 0;
  let lastModified = 0;

  for await (const entry of handle.values()) {
    throwIfAborted(options.signal);
    if (isHiddenName(entry.name)) {
      continue;
    }
    const pathSegments = [...parentSegments, entry.name];
    if (entry.kind === 'directory') {
      const nested = await scanFolder(entry, rootId, pathSegments, options);
      children.push({
        children: nested.children,
        handle: entry,
        id: makeVaultNodeId(rootId, pathSegments),
        lastModified: nested.lastModified,
        name: entry.name,
        noteCount: nested.noteCount,
        pathSegments,
        rootId,
        type: 'folder',
      });
      noteCount += nested.noteCount;
      lastModified = Math.max(lastModified, nested.lastModified);
    } else if (isVaultNoteName(entry.name)) {
      const note = await scanNote(entry, rootId, pathSegments);
      children.push(note);
      noteCount += 1;
      lastModified = Math.max(lastModified, note.lastModified);
    }
  }

  return { children, lastModified, noteCount };
}

/**
 * Recursively scans a vault root directory into an immutable note/folder
 * tree. Only markdown notes are included; hidden (dot-prefixed) entries are
 * skipped entirely. Folders aggregate a recursive noteCount and the max
 * descendant note lastModified so time-based sorting works on folders too.
 */
export async function scanVaultDirectory(
  handle: VaultDirectoryHandleLike,
  rootId: VaultRootId,
  options: VaultScanOptions = {}
): Promise<VaultScanResult> {
  throwIfAborted(options.signal);
  const scan = await scanFolder(handle, rootId, [], options);
  return { nodes: scan.children, noteCount: scan.noteCount };
}
