import { webRootPath } from '@brainstrike/web-state-store';
import { describe, expect, it, vi } from 'vitest';
import { fileIdentity } from '../file-index-authority';
import { fsaWorkspaceLease } from '../fsa-workspace-lease';
import { fsaWorkspaceRoot } from '../fsa-workspace-root';

const rootId = '11111111-1111-4111-8111-111111111111';

function fileHandle(file: File): FileSystemFileHandle {
  return {
    getFile: vi.fn(async () => file),
    kind: 'file',
    name: file.name,
  } as unknown as FileSystemFileHandle;
}

function directory(children: ReadonlyMap<string, FileSystemHandle> = new Map()) {
  const getDirectoryHandle = vi.fn(async (name: string) => {
    const child = children.get(name);
    if (!child) {
      throw new DOMException('Missing directory', 'NotFoundError');
    }
    if (child.kind !== 'directory') {
      throw new DOMException('Not a directory', 'TypeMismatchError');
    }
    return child as FileSystemDirectoryHandle;
  });
  const getFileHandle = vi.fn(async (name: string) => {
    const child = children.get(name);
    if (!child) {
      throw new DOMException('Missing file', 'NotFoundError');
    }
    if (child.kind !== 'file') {
      throw new DOMException('Not a file', 'TypeMismatchError');
    }
    return child as FileSystemFileHandle;
  });
  const entries = vi.fn(async function* () {
    yield* children;
  });
  const handle = {
    entries,
    getDirectoryHandle,
    getFileHandle,
    kind: 'directory',
    name: 'folder',
  } as unknown as FileSystemDirectoryHandle;
  return { entries, getDirectoryHandle, getFileHandle, handle };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Promise not initialized');
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error('Promise not initialized');
  };
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, reject, resolve };
}

describe('a granted workspace folder', () => {
  it('lists nested files with byte sizes and directory identity, without following links', async () => {
    const file = new File(['café'], 'note.md', { lastModified: 1234 });
    const nested = directory(
      new Map<string, FileSystemHandle>([
        ['note.md', fileHandle(file)],
        ['subfolder', directory().handle],
      ])
    );
    const granted = directory(new Map([['docs', nested.handle]]));
    const root = fsaWorkspaceRoot(granted.handle);
    expect(await root.listDir('docs', 2)).toEqual({
      entries: [
        {
          isDirectory: false,
          isFile: true,
          isSymbolicLink: false,
          lastModified: 1234,
          name: 'note.md',
          size: 5,
        },
        { isDirectory: true, isFile: false, isSymbolicLink: false, name: 'subfolder' },
      ],
      inspected: 2,
      truncated: false,
    });
    expect(await root.readFile('docs/note.md', 5)).toEqual({
      content: new TextEncoder().encode('café'),
      status: 'ok',
    });
    expect(granted.getDirectoryHandle).toHaveBeenCalledWith('docs');
  });

  it('reports truncation without opening files beyond the listing budget', async () => {
    const unread = fileHandle(new File(['private'], 'later.md'));
    const granted = directory(
      new Map<string, FileSystemHandle>([
        ['first', directory().handle],
        ['later.md', unread],
      ])
    );
    const root = fsaWorkspaceRoot(granted.handle);
    expect(await root.listDir('.', 1)).toEqual({
      entries: [{ isDirectory: true, isFile: false, isSymbolicLink: false, name: 'first' }],
      inspected: 1,
      truncated: true,
    });
    expect(await root.listDir('.', 0)).toEqual({ entries: [], inspected: 0, truncated: true });
    expect(unread.getFile).not.toHaveBeenCalled();
  });

  it.each([
    '',
    '/outside',
    '../outside',
    'docs/../outside',
    './note',
    'docs//note',
    'docs/',
    'docs/./note',
    String.raw`docs\note`,
  ])('refuses traversal or noncanonical path %j before touching the grant', async (path) => {
    const granted = directory();
    const root = fsaWorkspaceRoot(granted.handle);
    await expect(root.listDir(path, 10)).rejects.toThrow('root-relative');
    await expect(root.readFile(path, 10)).rejects.toThrow('root-relative');
    expect(granted.entries).not.toHaveBeenCalled();
    expect(granted.getDirectoryHandle).not.toHaveBeenCalled();
    expect(granted.getFileHandle).not.toHaveBeenCalled();
  });

  it('distinguishes missing directories, missing files and the wrong handle kind', async () => {
    const granted = directory(
      new Map<string, FileSystemHandle>([
        ['folder', directory().handle],
        ['file', fileHandle(new File(['x'], 'file'))],
      ])
    );
    const root = fsaWorkspaceRoot(granted.handle);
    expect(await root.listDir('absent', 10)).toBeNull();
    expect(await root.listDir('file', 10)).toBeNull();
    for (const path of ['.', 'absent/file', 'absent', 'folder', 'file/child']) {
      expect(await root.readFile(path, 10)).toEqual({ status: 'not-found' });
    }
  });

  it('checks the byte budget before reading file contents', async () => {
    const file = new File(['café'], 'note');
    const bytes = vi.spyOn(file, 'arrayBuffer');
    const root = fsaWorkspaceRoot(directory(new Map([['note', fileHandle(file)]])).handle);
    expect(await root.readFile('note', 4)).toEqual({ status: 'oversized' });
    expect(bytes).not.toHaveBeenCalled();
    expect(await root.readFile('note', 5)).toEqual({
      content: new TextEncoder().encode('café'),
      status: 'ok',
    });
    expect(bytes).toHaveBeenCalledOnce();
  });

  it('reports a revoked file grant as unreadable and keeps unrelated I/O failures visible', async () => {
    const handle = fileHandle(new File(['text'], 'note'));
    const granted = directory(new Map([['note', handle]]));
    const root = fsaWorkspaceRoot(granted.handle);
    vi.mocked(handle.getFile).mockRejectedValueOnce(
      new DOMException('Permission revoked', 'NotAllowedError')
    );
    expect(await root.readFile('note', 10)).toEqual({ status: 'unreadable' });
    const failure = new Error('I/O failed');
    vi.mocked(handle.getFile).mockRejectedValueOnce(failure);
    await expect(root.readFile('note', 10)).rejects.toBe(failure);
    granted.getDirectoryHandle.mockRejectedValue(failure);
    await expect(root.listDir('docs', 10)).rejects.toBe(failure);
    await expect(root.readFile('docs/note', 10)).rejects.toBe(failure);
  });
});

describe('a workspace ingestion lease', () => {
  const context = () => ({ requestId: 'scan', signal: new AbortController().signal });

  it('names the durable root and gives each borrow a distinct generation', async () => {
    const folder = directory().handle;
    const first = fsaWorkspaceLease(rootId, folder);
    const second = fsaWorkspaceLease(rootId, folder);
    expect(first.rootId).toBe(rootId);
    expect(first.canonicalPath).toBe(webRootPath(rootId));
    expect(first.generation).not.toBe(second.generation);
    expect(first.signal.aborted).toBe(false);
    expect(await first.listDir('.', 10, context())).toEqual({
      entries: [],
      inspected: 0,
      truncated: false,
    });
    const subscription = await first.subscribe(vi.fn(), vi.fn(), vi.fn(), context());
    await expect(subscription.close()).resolves.toBeUndefined();
    await Promise.all([first.retire(), second.retire()]);
  });

  it('refuses cancelled operations and revoked leases before admitting another read', async () => {
    const granted = directory();
    const lease = fsaWorkspaceLease(rootId, granted.handle);
    const reason = new DOMException('Cancelled', 'AbortError');
    const cancelled = { requestId: 'cancelled', signal: AbortSignal.abort(reason) };
    expect(() => lease.listDir('.', 10, cancelled)).toThrow(reason);
    expect(() => lease.readFile('note', 10, cancelled)).toThrow(reason);
    lease.revoke(reason);
    expect(lease.signal.reason).toBe(reason);
    expect(() => lease.listDir('.', 10, context())).toThrow(reason);
    expect(() => lease.readFile('note', 10, context())).toThrow(reason);
    expect(granted.entries).not.toHaveBeenCalled();
    expect(granted.getFileHandle).not.toHaveBeenCalled();
    await lease.retire();
  });

  it.each(['resolve', 'reject'] as const)(
    'retirement joins an admitted read that will %s, even after revocation',
    async (outcome) => {
      const pending = deferred<File>();
      const handle = fileHandle(new File(['text'], 'note'));
      vi.mocked(handle.getFile).mockReturnValue(pending.promise);
      const lease = fsaWorkspaceLease(rootId, directory(new Map([['note', handle]])).handle);
      const reading = lease.readFile('note', 10, context());
      const failure = new Error('Read failed');
      const observed =
        outcome === 'reject'
          ? expect(reading).rejects.toBe(failure)
          : expect(reading).resolves.toMatchObject({ status: 'ok' });
      lease.revoke(new DOMException('Root retired', 'AbortError'));
      let retired = false;
      const retiring = lease.retire().then(() => {
        retired = true;
      });
      await Promise.resolve();
      expect(retired).toBe(false);
      if (outcome === 'resolve') {
        pending.resolve(new File(['text'], 'note'));
      } else {
        pending.reject(failure);
      }
      await observed;
      await retiring;
      expect(retired).toBe(true);
      // A settled rejection remains owned by the caller; later retirement has no orphaned work.
      await expect(lease.retire()).resolves.toBeUndefined();
    }
  );
});

describe('catalog file identity', () => {
  const file = {
    embeddingSetId: 'set',
    fileId: 'file',
    fileName: 'note.md',
    path: 'docs/note.md',
    rootId,
  };
  it('keeps rooted paths under their durable folder key and leaves imports unrooted', () => {
    expect(fileIdentity(file)).toEqual({
      embeddingSetId: 'set',
      fileId: 'file',
      fileName: 'note.md',
      relativePath: file.path,
      rootId,
      sourcePath: `${webRootPath(rootId)}/${file.path}`,
    });
    expect(fileIdentity({ ...file, rootId: null })).toEqual({
      embeddingSetId: 'set',
      fileId: 'file',
      fileName: 'note.md',
      relativePath: null,
      rootId: null,
      sourcePath: file.path,
    });
    expect(fileIdentity({ ...file, path: null, rootId: null }).sourcePath).toBeNull();
  });
  it('refuses to fabricate a source path for a rooted file without one', () => {
    expect(() => fileIdentity({ ...file, path: null })).toThrow('root-relative path');
  });
});
