import { describe, expect, it, vi } from 'vitest';
import { scanVaultDirectory } from '../../core/scan';
import { writeNoteFile } from '../../core/write-note';
import type { NotesVaultBridge, NotesVaultBridgeEntry, NotesVaultResult } from '../bridge-contract';
import { createNodeVaultDirectoryHandle } from '../node-vault-handles';

interface FakeFsFile {
  content: string;
  kind: 'file';
  lastModified: number;
}
interface FakeFsDir {
  kind: 'directory';
}
type FakeFsEntry = FakeFsFile | FakeFsDir;

function ok<T>(value: T): NotesVaultResult<T> {
  return { ok: true, value };
}

/** Path-keyed in-memory bridge; keys are absolute POSIX-ish paths. */
function fakeBridge(entries: Record<string, FakeFsEntry>): NotesVaultBridge & {
  createdDirectories: string[];
  deleted: { path: string; recursive: boolean }[];
  fs: Map<string, FakeFsEntry>;
  readFileCalls: string[];
  renames: { from: string; to: string }[];
} {
  const fs = new Map(Object.entries(entries));
  const readFileCalls: string[] = [];
  const createdDirectories: string[] = [];
  const deleted: { path: string; recursive: boolean }[] = [];
  const renames: { from: string; to: string }[] = [];
  const entryFor = (path: string): NotesVaultBridgeEntry | null => {
    const entry = fs.get(path);
    if (!entry) {
      return null;
    }
    const name = path.split('/').at(-1) ?? path;
    return entry.kind === 'file'
      ? { kind: 'file', lastModified: entry.lastModified, name, size: entry.content.length }
      : { kind: 'directory', lastModified: 0, name, size: 0 };
  };
  return {
    createDirectory: (path: string) => {
      createdDirectories.push(path);
      fs.set(path, { kind: 'directory' });
      return Promise.resolve(ok(null));
    },
    createdDirectories,
    deleted,
    deleteEntry: (path: string, options: { recursive: boolean }) => {
      deleted.push({ path, recursive: options.recursive });
      fs.delete(path);
      return Promise.resolve(ok(null));
    },
    ensureDefaultVault: () => Promise.resolve(ok({ name: 'Brainstrike Notes', path: '/docs/n' })),
    fs,
    listDirectory: (path: string) => {
      if (!fs.has(path)) {
        return Promise.resolve({ error: `not a directory: ${path}`, ok: false as const });
      }
      const children: NotesVaultBridgeEntry[] = [];
      for (const key of fs.keys()) {
        if (key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')) {
          const entry = entryFor(key);
          if (entry) {
            children.push(entry);
          }
        }
      }
      return Promise.resolve(ok(children));
    },
    onChanged: () => () => undefined,
    pickDirectory: () => Promise.resolve(ok(null)),
    readFile: (path: string) => {
      readFileCalls.push(path);
      const entry = fs.get(path);
      if (entry?.kind !== 'file') {
        return Promise.resolve({ error: `no such file: ${path}`, ok: false as const });
      }
      return Promise.resolve(ok(entry.content));
    },
    readFileCalls,
    registerRoot: (path: string) =>
      Promise.resolve(ok({ name: path.split('/').at(-1) ?? path, path })),
    rename: (fromPath: string, toPath: string) => {
      renames.push({ from: fromPath, to: toPath });
      const entry = fs.get(fromPath);
      if (entry) {
        fs.delete(fromPath);
        fs.set(toPath, entry);
      }
      return Promise.resolve(ok(null));
    },
    renames,
    statEntry: (path: string) => Promise.resolve(ok(entryFor(path))),
    unwatch: () => Promise.resolve(ok(null)),
    watch: () => Promise.resolve(ok({ watchId: 'w1' })),
    writeFile: (path: string, content: string) => {
      fs.set(path, { content, kind: 'file', lastModified: 999 });
      return Promise.resolve(ok({ lastModified: 999 }));
    },
  };
}

describe('createNodeVaultDirectoryHandle', () => {
  const VAULT: Record<string, FakeFsEntry> = {
    '/vault': { kind: 'directory' },
    '/vault/inbox.md': { content: '# Inbox', kind: 'file', lastModified: 100 },
    '/vault/projects': { kind: 'directory' },
    '/vault/projects/plan.md': { content: '# Plan', kind: 'file', lastModified: 200 },
  };

  it('scans through the shared core without reading file contents', async () => {
    const bridge = fakeBridge(VAULT);
    const root = createNodeVaultDirectoryHandle(bridge, '/vault', 'vault');

    const result = await scanVaultDirectory(root, 'r1');

    expect(result.noteCount).toBe(2);
    expect(result.nodes.map((node) => node.name).sort()).toEqual(['inbox.md', 'projects']);
    const inbox = result.nodes.find((node) => node.name === 'inbox.md');
    expect(inbox).toMatchObject({ lastModified: 100, size: 7 });
    expect(bridge.readFileCalls).toEqual([]);
  });

  it('reads note content lazily through getFile()', async () => {
    const bridge = fakeBridge(VAULT);
    const root = createNodeVaultDirectoryHandle(bridge, '/vault', 'vault');
    const { nodes } = await scanVaultDirectory(root, 'r1');
    const inbox = nodes.find((node) => node.name === 'inbox.md');

    const file = await (inbox?.type === 'note' ? inbox.handle.getFile() : Promise.reject());

    expect(await file.text()).toBe('# Inbox');
    expect(file.lastModified).toBe(100);
  });

  it('writes atomically through the bridge (createWritable contract)', async () => {
    const bridge = fakeBridge(VAULT);
    const root = createNodeVaultDirectoryHandle(bridge, '/vault', 'vault');
    const inbox = await root.getFileHandle('inbox.md');

    await writeNoteFile(inbox, 'updated body');

    expect((bridge.fs.get('/vault/inbox.md') as FakeFsFile).content).toBe('updated body');
  });

  it('honors the FSA error contract for missing entries and kind mismatches', async () => {
    const bridge = fakeBridge(VAULT);
    const root = createNodeVaultDirectoryHandle(bridge, '/vault', 'vault');

    await expect(root.getFileHandle('missing.md')).rejects.toMatchObject({
      name: 'NotFoundError',
    });
    await expect(root.getFileHandle('projects')).rejects.toMatchObject({
      name: 'TypeMismatchError',
    });
    await expect(root.getDirectoryHandle('inbox.md')).rejects.toMatchObject({
      name: 'TypeMismatchError',
    });
    // create:true on a file returns a handle whose first write creates it.
    const created = await root.getFileHandle('new.md', { create: true });
    await writeNoteFile(created, 'fresh');
    expect((bridge.fs.get('/vault/new.md') as FakeFsFile).content).toBe('fresh');
  });

  it('reports granted permissions and path-based identity', async () => {
    const bridge = fakeBridge(VAULT);
    const a = createNodeVaultDirectoryHandle(bridge, '/vault', 'vault');
    const b = createNodeVaultDirectoryHandle(bridge, '/vault', 'vault');
    const other = createNodeVaultDirectoryHandle(bridge, '/other', 'other');

    await expect(a.queryPermission?.({ mode: 'readwrite' })).resolves.toBe('granted');
    await expect(a.isSameEntry(b)).resolves.toBe(true);
    await expect(a.isSameEntry(other)).resolves.toBe(false);
  });

  it('surfaces bridge failures as thrown errors (no silent fallback)', async () => {
    const bridge = fakeBridge(VAULT);
    const failing = vi
      .spyOn(bridge, 'listDirectory')
      .mockResolvedValue({ error: 'disk detached', ok: false });
    const root = createNodeVaultDirectoryHandle(bridge, '/vault', 'vault');

    await expect(scanVaultDirectory(root, 'r1')).rejects.toThrow(/disk detached/);
    failing.mockRestore();
  });
});

describe('entry management over the bridge', () => {
  const VAULT2: Record<string, FakeFsEntry> = {
    '/vault': { kind: 'directory' },
    '/vault/inbox.md': { content: '# Inbox', kind: 'file', lastModified: 100 },
    '/vault/projects': { kind: 'directory' },
  };

  it('creates folders through getDirectoryHandle(create)', async () => {
    const bridge = fakeBridge(VAULT2);
    const root = createNodeVaultDirectoryHandle(bridge, '/vault', 'vault');

    const created = await root.getDirectoryHandle('new-folder', { create: true });

    expect(created.kind).toBe('directory');
    expect(bridge.createdDirectories).toContain('/vault/new-folder');
  });

  it('deletes entries through removeEntry', async () => {
    const bridge = fakeBridge(VAULT2);
    const root = createNodeVaultDirectoryHandle(bridge, '/vault', 'vault');

    await root.removeEntry?.('inbox.md');
    await root.removeEntry?.('projects', { recursive: true });

    expect(bridge.deleted).toEqual([
      { path: '/vault/inbox.md', recursive: false },
      { path: '/vault/projects', recursive: true },
    ]);
  });

  it('renames entries via move (same-directory)', async () => {
    const bridge = fakeBridge(VAULT2);
    const root = createNodeVaultDirectoryHandle(bridge, '/vault', 'vault');
    const note = await root.getFileHandle('inbox.md');
    const folder = await root.getDirectoryHandle('projects');

    await note.move?.('renamed.md');
    await folder.move?.('archive');

    expect(bridge.renames).toEqual([
      { from: '/vault/inbox.md', to: '/vault/renamed.md' },
      { from: '/vault/projects', to: '/vault/archive' },
    ]);
  });

  it('move updates the handle path so later writes hit the new location', async () => {
    const bridge = fakeBridge(VAULT2);
    const root = createNodeVaultDirectoryHandle(bridge, '/vault', 'vault');
    const note = await root.getFileHandle('inbox.md');

    await note.move?.('renamed.md');
    await writeNoteFile(note, 'post-rename write');

    expect((bridge.fs.get('/vault/renamed.md') as FakeFsFile).content).toBe('post-rename write');
    expect(bridge.fs.has('/vault/inbox.md')).toBe(false);
    expect(note.name).toBe('renamed.md');
  });

  it('surfaces bridge refusals as thrown errors', async () => {
    const bridge = fakeBridge(VAULT2);
    bridge.deleteEntry = () => Promise.resolve({ error: 'outside approved root', ok: false });
    const root = createNodeVaultDirectoryHandle(bridge, '/vault', 'vault');

    await expect(root.removeEntry?.('inbox.md')).rejects.toThrow(/outside approved root/);
  });
});
