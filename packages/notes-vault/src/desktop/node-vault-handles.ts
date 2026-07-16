import type {
  VaultDirectoryHandleLike,
  VaultFileHandleLike,
  VaultHandleLike,
  VaultPermissionState,
  VaultWritableLike,
} from '../core/types';
import type { NotesVaultBridge, NotesVaultBridgeEntry, NotesVaultResult } from './bridge-contract';

/**
 * Adapts the desktop bridge (Node fs in main, over IPC) to the same
 * VaultDirectoryHandleLike seam the web File System Access backend uses, so
 * the entire vault core/store/UI pipeline is shared verbatim. Listings carry
 * metadata, so scans never read file contents (stat() fast path); the OS
 * grants access, so permissions always report 'granted'.
 */

function unwrap<T>(result: NotesVaultResult<T>): T {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

function joinPath(parent: string, name: string): string {
  const separator = parent.includes('\\') ? '\\' : '/';
  return parent.endsWith(separator) ? `${parent}${name}` : `${parent}${separator}${name}`;
}

class NodeVaultFileHandle implements VaultFileHandleLike {
  readonly kind = 'file' as const;
  readonly name: string;
  readonly path: string;
  readonly #bridge: NotesVaultBridge;
  readonly #meta: { lastModified: number; size: number } | null;

  constructor(
    bridge: NotesVaultBridge,
    path: string,
    name: string,
    meta: { lastModified: number; size: number } | null
  ) {
    this.#bridge = bridge;
    this.path = path;
    this.name = name;
    this.#meta = meta;
  }

  async stat(): Promise<{ lastModified: number; size: number }> {
    if (this.#meta) {
      return this.#meta;
    }
    const entry = unwrap(await this.#bridge.statEntry(this.path));
    if (entry?.kind !== 'file') {
      throw new DOMException(`${this.path} not found`, 'NotFoundError');
    }
    return { lastModified: entry.lastModified, size: entry.size };
  }

  async getFile(): Promise<File> {
    const [content, meta] = await Promise.all([
      this.#bridge.readFile(this.path).then(unwrap),
      this.stat().catch(() => null),
    ]);
    return new File([content], this.name, { lastModified: meta?.lastModified ?? 0 });
  }

  createWritable(): Promise<VaultWritableLike> {
    const bridge = this.#bridge;
    const path = this.path;
    let buffer = '';
    let closed = false;
    return Promise.resolve({
      close: async (): Promise<void> => {
        if (closed) {
          throw new TypeError('already closed');
        }
        closed = true;
        // Atomicity lives in main (temp+rename, O_NOFOLLOW) — buffering here
        // preserves the createWritable swap-file contract over IPC.
        unwrap(await bridge.writeFile(path, buffer));
      },
      write: (data: string): Promise<void> => {
        if (closed) {
          return Promise.reject(new TypeError('write after close'));
        }
        buffer += data;
        return Promise.resolve();
      },
    });
  }

  isSameEntry(other: VaultHandleLike): Promise<boolean> {
    return Promise.resolve(other instanceof NodeVaultFileHandle && other.path === this.path);
  }
}

class NodeVaultDirectoryHandle implements VaultDirectoryHandleLike {
  readonly kind = 'directory' as const;
  readonly name: string;
  readonly path: string;
  readonly #bridge: NotesVaultBridge;

  constructor(bridge: NotesVaultBridge, path: string, name: string) {
    this.#bridge = bridge;
    this.path = path;
    this.name = name;
  }

  #childFor(entry: NotesVaultBridgeEntry): VaultHandleLike {
    const childPath = joinPath(this.path, entry.name);
    if (entry.kind === 'directory') {
      return new NodeVaultDirectoryHandle(this.#bridge, childPath, entry.name);
    }
    return new NodeVaultFileHandle(this.#bridge, childPath, entry.name, {
      lastModified: entry.lastModified,
      size: entry.size,
    });
  }

  async *values(): AsyncIterableIterator<VaultHandleLike> {
    const entries = unwrap(await this.#bridge.listDirectory(this.path));
    for (const entry of entries) {
      yield this.#childFor(entry);
    }
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<VaultDirectoryHandleLike> {
    if (options?.create) {
      throw new Error('Creating folders is not supported through the notes vault bridge yet');
    }
    const childPath = joinPath(this.path, name);
    const entry = unwrap(await this.#bridge.statEntry(childPath));
    if (!entry) {
      throw new DOMException(`${name} not found`, 'NotFoundError');
    }
    if (entry.kind !== 'directory') {
      throw new DOMException(`${name} is a file`, 'TypeMismatchError');
    }
    return new NodeVaultDirectoryHandle(this.#bridge, childPath, name);
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<VaultFileHandleLike> {
    const childPath = joinPath(this.path, name);
    const entry = unwrap(await this.#bridge.statEntry(childPath));
    if (entry?.kind === 'directory') {
      throw new DOMException(`${name} is a directory`, 'TypeMismatchError');
    }
    if (entry) {
      return new NodeVaultFileHandle(this.#bridge, childPath, name, {
        lastModified: entry.lastModified,
        size: entry.size,
      });
    }
    if (options?.create) {
      // Creation happens on first write (main's contained O_CREAT path).
      return new NodeVaultFileHandle(this.#bridge, childPath, name, null);
    }
    throw new DOMException(`${name} not found`, 'NotFoundError');
  }

  isSameEntry(other: VaultHandleLike): Promise<boolean> {
    return Promise.resolve(other instanceof NodeVaultDirectoryHandle && other.path === this.path);
  }

  queryPermission(): Promise<VaultPermissionState> {
    return Promise.resolve('granted');
  }

  requestPermission(): Promise<VaultPermissionState> {
    return Promise.resolve('granted');
  }
}

export function createNodeVaultDirectoryHandle(
  bridge: NotesVaultBridge,
  path: string,
  name: string
): VaultDirectoryHandleLike {
  return new NodeVaultDirectoryHandle(bridge, path, name);
}

/** The absolute path behind a node-backed handle; null for other backends. */
export function nodeVaultHandlePath(handle: VaultDirectoryHandleLike): string | null {
  return handle instanceof NodeVaultDirectoryHandle ? handle.path : null;
}
