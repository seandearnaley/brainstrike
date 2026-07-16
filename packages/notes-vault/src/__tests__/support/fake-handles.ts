import type {
  VaultDirectoryHandleLike,
  VaultFileHandleLike,
  VaultHandleLike,
  VaultPermissionState,
  VaultWritableLike,
} from '../../core/types';

interface FakeFileState {
  content: string;
  lastModified: number;
}

/**
 * In-memory FileSystemFileHandle stand-in. Mirrors the atomic
 * createWritable() contract: writes buffer into a swap and only become
 * visible on close().
 */
export class FakeFileHandle implements VaultFileHandleLike {
  readonly kind = 'file' as const;
  name: string;
  parent: FakeDirectoryHandle | null = null;
  readonly state: FakeFileState;

  constructor(name: string, state?: Partial<FakeFileState>) {
    this.name = name;
    this.state = { content: state?.content ?? '', lastModified: state?.lastModified ?? 0 };
  }

  move(newName: string): Promise<void> {
    return moveFakeEntry(this, newName);
  }

  getFile(): Promise<File> {
    return Promise.resolve(
      new File([this.state.content], this.name, { lastModified: this.state.lastModified })
    );
  }

  createWritable(): Promise<VaultWritableLike> {
    let swap = '';
    let closed = false;
    const state = this.state;
    return Promise.resolve({
      close(): Promise<void> {
        if (closed) {
          return Promise.reject(new TypeError('already closed'));
        }
        closed = true;
        state.content = swap;
        state.lastModified = Date.now();
        return Promise.resolve();
      },
      write(data: string): Promise<void> {
        if (closed) {
          return Promise.reject(new TypeError('write after close'));
        }
        swap += data;
        return Promise.resolve();
      },
    });
  }

  isSameEntry(other: VaultHandleLike): Promise<boolean> {
    return Promise.resolve(other === this);
  }
}

export class FakeDirectoryHandle implements VaultDirectoryHandleLike {
  readonly kind = 'directory' as const;
  name: string;
  parent: FakeDirectoryHandle | null = null;
  readonly entries: Map<string, FakeFileHandle | FakeDirectoryHandle>;
  permissionState: VaultPermissionState = 'granted';
  /** What requestPermission resolves (and transitions state) to. */
  requestOutcome: VaultPermissionState = 'granted';

  constructor(name: string, children: readonly (FakeFileHandle | FakeDirectoryHandle)[] = []) {
    this.name = name;
    this.entries = new Map(children.map((child) => [child.name, child]));
    for (const child of children) {
      child.parent = this;
    }
  }

  move(newName: string): Promise<void> {
    return moveFakeEntry(this, newName);
  }

  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const existing = this.entries.get(name);
    if (!existing) {
      return Promise.reject(new DOMException(`${name} not found`, 'NotFoundError'));
    }
    if (
      existing instanceof FakeDirectoryHandle &&
      existing.entries.size > 0 &&
      !options?.recursive
    ) {
      return Promise.reject(new DOMException(`${name} is not empty`, 'InvalidModificationError'));
    }
    this.entries.delete(name);
    return Promise.resolve();
  }

  async *values(): AsyncIterableIterator<VaultHandleLike> {
    yield* this.entries.values();
  }

  getDirectoryHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<VaultDirectoryHandleLike> {
    const existing = this.entries.get(name);
    if (existing instanceof FakeDirectoryHandle) {
      return Promise.resolve(existing);
    }
    if (existing) {
      return Promise.reject(new DOMException(`${name} is a file`, 'TypeMismatchError'));
    }
    if (options?.create) {
      const created = new FakeDirectoryHandle(name);
      created.parent = this;
      this.entries.set(name, created);
      return Promise.resolve(created);
    }
    return Promise.reject(new DOMException(`${name} not found`, 'NotFoundError'));
  }

  getFileHandle(name: string, options?: { create?: boolean }): Promise<VaultFileHandleLike> {
    const existing = this.entries.get(name);
    if (existing instanceof FakeFileHandle) {
      return Promise.resolve(existing);
    }
    if (existing) {
      return Promise.reject(new DOMException(`${name} is a directory`, 'TypeMismatchError'));
    }
    if (options?.create) {
      const created = new FakeFileHandle(name);
      created.parent = this;
      this.entries.set(name, created);
      return Promise.resolve(created);
    }
    return Promise.reject(new DOMException(`${name} not found`, 'NotFoundError'));
  }

  isSameEntry(other: VaultHandleLike): Promise<boolean> {
    return Promise.resolve(other === this);
  }

  queryPermission(): Promise<VaultPermissionState> {
    return Promise.resolve(this.permissionState);
  }

  requestPermission(): Promise<VaultPermissionState> {
    this.permissionState = this.requestOutcome;
    return Promise.resolve(this.requestOutcome);
  }
}

/** Same-directory rename shared by both fake handle kinds. */
function moveFakeEntry(
  entry: FakeFileHandle | FakeDirectoryHandle,
  newName: string
): Promise<void> {
  const parent = entry.parent;
  if (!parent) {
    return Promise.reject(new DOMException('entry has no parent', 'InvalidStateError'));
  }
  if (parent.entries.has(newName)) {
    return Promise.reject(new DOMException(`${newName} exists`, 'InvalidModificationError'));
  }
  parent.entries.delete(entry.name);
  entry.name = newName;
  parent.entries.set(newName, entry);
  return Promise.resolve();
}

export function fakeNote(
  name: string,
  state?: { content?: string; lastModified?: number }
): FakeFileHandle {
  return new FakeFileHandle(name, state);
}

export function fakeDir(
  name: string,
  children: readonly (FakeFileHandle | FakeDirectoryHandle)[] = []
): FakeDirectoryHandle {
  return new FakeDirectoryHandle(name, children);
}
