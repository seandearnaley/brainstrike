/**
 * Coverage for the notes vault IPC handler layer (approved-roots security
 * model), using REAL temp-dir filesystem state — containment, symlink
 * skipping, and welcome-note seeding are filesystem behaviors, so we never
 * mock fs here. The watcher factory and directory picker are injected fakes
 * (chokidar wiring lives in ipc-notes-vault.ts / the file-system package).
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const { registeredHandlers, removeHandler } = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    registeredHandlers: handlers,
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, listener: IpcHandler) => {
      registeredHandlers.set(channel, listener);
    }),
    on: vi.fn(),
    removeHandler,
    removeListener: vi.fn(),
  },
}));

import {
  approvedNotesVaultRootCountForTest,
  createNotesVaultIpcHandlers,
  DEFAULT_NOTES_VAULT_DIRECTORY_NAME,
  disposeAllNotesVaultWatchers,
  liveNotesVaultWatcherCountForTest,
  NOTES_VAULT_ROOTS_STORAGE_KEY,
  type NotesVaultChangedEvent,
  type NotesVaultIpcHandlers,
  type NotesVaultIpcHandlersOptions,
  type NotesVaultRootsStorage,
  registerNotesVaultIpcHandlers,
  resetNotesVaultIpcStateForTest,
} from '../../notes-vault-ipc-handlers';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

const createdDirs: string[] = [];

async function makeDir(prefix = 'brainstrike-notes-vault-ipc-'): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  const real = await fsPromises.realpath(dir);
  createdDirs.push(real);
  return real;
}

/** A minimal WebContents stand-in that records the change events pushed to it. */
class FakeWebContents {
  readonly id: number;
  readonly changedEvents: NotesVaultChangedEvent[] = [];
  private destroyed = false;
  private destroyedListeners: (() => void)[] = [];

  constructor(id: number) {
    this.id = id;
  }

  send(channel: string, payload: unknown): void {
    if (channel === DESKTOP_IPC_CHANNELS.notesVault.changed) {
      this.changedEvents.push(payload as NotesVaultChangedEvent);
    }
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  once(event: string, listener: () => void): void {
    if (event === 'destroyed') {
      this.destroyedListeners.push(listener);
    }
  }

  /** Test helper: simulate the renderer being destroyed. */
  fireDestroyed(): void {
    this.destroyed = true;
    const listeners = this.destroyedListeners;
    this.destroyedListeners = [];
    for (const listener of listeners) {
      listener();
    }
  }
}

function castOwner(owner: FakeWebContents): WebContents {
  return owner as unknown as WebContents;
}

interface WatchHarness {
  /** Fire every live fake watcher's onChange callback. */
  fireAllChanges: () => void;
  startedPaths: string[];
  startWatch: NotesVaultIpcHandlersOptions['startWatch'];
  stops: ReturnType<typeof vi.fn>[];
}

function createWatchHarness(): WatchHarness {
  const startedPaths: string[] = [];
  const stops: ReturnType<typeof vi.fn>[] = [];
  const liveCallbacks = new Set<() => void>();
  return {
    fireAllChanges: () => {
      for (const callback of Array.from(liveCallbacks)) {
        callback();
      }
    },
    startedPaths,
    startWatch: (directoryPath, onChange) => {
      startedPaths.push(directoryPath);
      liveCallbacks.add(onChange);
      const stop = vi.fn(() => {
        liveCallbacks.delete(onChange);
      });
      stops.push(stop);
      return Promise.resolve(stop);
    },
    stops,
  };
}

/** In-memory NotesVaultRootsStorage fake exposing its backing map to assertions. */
interface FakeRootsStorage extends NotesVaultRootsStorage {
  readonly data: Map<string, string>;
}

function createFakeRootsStorage(): FakeRootsStorage {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => Promise.resolve(data.get(key) ?? null),
    setItem: (key: string, value: string) => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

/** Read the persisted approved-roots list straight out of the fake storage. */
function persistedRoots(storage: FakeRootsStorage): string[] {
  const raw = storage.data.get(NOTES_VAULT_ROOTS_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as string[]) : [];
}

/** Seed a path into main's persisted list, simulating a prior picker approval. */
function seedPersistedRoot(storage: FakeRootsStorage, rootPath: string): void {
  storage.data.set(
    NOTES_VAULT_ROOTS_STORAGE_KEY,
    JSON.stringify([...persistedRoots(storage), rootPath])
  );
}

function createHandlers(overrides: Partial<NotesVaultIpcHandlersOptions> = {}): {
  handlers: NotesVaultIpcHandlers;
  storage: FakeRootsStorage;
  /** Fake OS-trash sink: records paths, never touches the filesystem. */
  trashItem: ReturnType<typeof vi.fn>;
  watchHarness: WatchHarness;
} {
  const watchHarness = createWatchHarness();
  const storage = createFakeRootsStorage();
  const trashItem = vi.fn((_absolutePath: string) => Promise.resolve());
  const handlers = createNotesVaultIpcHandlers({
    getDefaultVaultParentPath: () => {
      throw new Error('getDefaultVaultParentPath not configured for this test');
    },
    pickDirectoryPath: () => Promise.resolve(null),
    startWatch: watchHarness.startWatch,
    storage,
    trashItem,
    ...overrides,
  });
  return {
    handlers,
    storage: (overrides.storage as FakeRootsStorage) ?? storage,
    trashItem,
    watchHarness,
  };
}

/**
 * Approve a root the way a restart-restore does: the path is ALREADY in
 * main's persisted list (picker-approved in a prior session), and registerRoot
 * re-approves it in memory.
 */
async function approveRoot(
  handlers: NotesVaultIpcHandlers,
  storage: FakeRootsStorage,
  rootPath: string
): Promise<void> {
  seedPersistedRoot(storage, rootPath);
  const result = await handlers.registerRoot(rootPath);
  expect(result).toMatchObject({ ok: true });
}

beforeEach(() => {
  resetNotesVaultIpcStateForTest();
  registeredHandlers.clear();
  removeHandler.mockClear();
});

afterEach(async () => {
  resetNotesVaultIpcStateForTest();
  for (const dir of createdDirs.splice(0)) {
    await fsPromises.rm(dir, { force: true, recursive: true });
  }
});

describe('notes vault IPC handlers', () => {
  describe('root approval', () => {
    it('registerRoot re-approves a persisted root with basename display name', async () => {
      const { handlers, storage } = createHandlers();
      const root = await makeDir();
      seedPersistedRoot(storage, root);
      const result = await handlers.registerRoot(root);
      expect(result).toEqual({
        ok: true,
        value: { name: path.basename(root), path: root },
      });
      expect(approvedNotesVaultRootCountForTest()).toBe(1);
    });

    it('registerRoot REJECTS an existing non-sensitive directory never approved by picker/default', async () => {
      const { handlers } = createHandlers();
      const root = await makeDir();
      const result = await handlers.registerRoot(root);
      expect(result).toMatchObject({ ok: false });
      expect((result as { error: string }).error).toContain('not an approved notes vault root');
      expect((result as { error: string }).error).toContain('picker');
      expect(approvedNotesVaultRootCountForTest()).toBe(0);
      // A renderer that could not self-approve also gets no read access.
      expect(await handlers.listDirectory(root)).toMatchObject({ ok: false });
    });

    it('rejects a missing path, a relative path, and a file root even when persisted', async () => {
      const { handlers, storage } = createHandlers();
      const root = await makeDir();
      const filePath = path.join(root, 'note.md');
      await fsPromises.writeFile(filePath, 'hi', 'utf8');
      // Validation runs BEFORE the persisted-list check: even seeded entries
      // must exist, be absolute, and be directories.
      seedPersistedRoot(storage, path.join(root, 'missing'));
      seedPersistedRoot(storage, filePath);

      expect(await handlers.registerRoot(path.join(root, 'missing'))).toMatchObject({ ok: false });
      expect(await handlers.registerRoot('relative/path')).toMatchObject({ ok: false });
      expect(await handlers.registerRoot(filePath)).toMatchObject({ ok: false });
      expect(await handlers.registerRoot(42)).toMatchObject({ ok: false });
      expect(approvedNotesVaultRootCountForTest()).toBe(0);
    });

    it('pickDirectory resolves { ok: true, value: null } on user cancel', async () => {
      const { handlers, storage } = createHandlers({
        pickDirectoryPath: () => Promise.resolve(null),
      });
      expect(await handlers.pickDirectory()).toEqual({ ok: true, value: null });
      expect(approvedNotesVaultRootCountForTest()).toBe(0);
      expect(persistedRoots(storage)).toEqual([]);
    });

    it('pickDirectory registers the picked directory as an approved root and persists it', async () => {
      const picked = await makeDir();
      const { handlers, storage } = createHandlers({
        pickDirectoryPath: () => Promise.resolve(picked),
      });
      expect(await handlers.pickDirectory()).toEqual({
        ok: true,
        value: { name: path.basename(picked), path: picked },
      });
      expect(approvedNotesVaultRootCountForTest()).toBe(1);
      expect(persistedRoots(storage)).toEqual([picked]);
    });

    it('registerRoot re-approves a picker-approved path after an app restart (same storage, fresh registrar)', async () => {
      const picked = await makeDir();
      const first = createHandlers({ pickDirectoryPath: () => Promise.resolve(picked) });
      expect(await first.handlers.pickDirectory()).toMatchObject({ ok: true });
      expect(approvedNotesVaultRootCountForTest()).toBe(1);

      // Simulate an app restart: the in-memory approved map is gone, the
      // durable storage survives.
      resetNotesVaultIpcStateForTest();
      expect(approvedNotesVaultRootCountForTest()).toBe(0);
      const second = createHandlers({ storage: first.storage });

      expect(await second.handlers.registerRoot(picked)).toEqual({
        ok: true,
        value: { name: path.basename(picked), path: picked },
      });
      expect(approvedNotesVaultRootCountForTest()).toBe(1);
      expect(await second.handlers.listDirectory(picked)).toMatchObject({ ok: true });
    });

    it('round-trips approvals through the injected storage without duplicates', async () => {
      const picked = await makeDir();
      const parent = await makeDir();
      const { handlers, storage } = createHandlers({
        getDefaultVaultParentPath: () => parent,
        pickDirectoryPath: () => Promise.resolve(picked),
      });

      expect(await handlers.pickDirectory()).toMatchObject({ ok: true });
      expect(persistedRoots(storage)).toEqual([picked]);

      expect(await handlers.ensureDefaultVault()).toMatchObject({ ok: true });
      const vaultPath = path.join(parent, DEFAULT_NOTES_VAULT_DIRECTORY_NAME);
      expect(persistedRoots(storage)).toEqual([picked, vaultPath]);

      // Re-approving is idempotent: no duplicate persisted entries.
      expect(await handlers.pickDirectory()).toMatchObject({ ok: true });
      expect(await handlers.ensureDefaultVault()).toMatchObject({ ok: true });
      expect(await handlers.registerRoot(picked)).toMatchObject({ ok: true });
      expect(persistedRoots(storage)).toEqual([picked, vaultPath]);
    });
  });

  describe('read containment', () => {
    it('rejects listDirectory/statEntry/readFile for paths outside every approved root', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      const outside = await makeDir();
      const outsideFile = path.join(outside, 'secret.md');
      await fsPromises.writeFile(outsideFile, 'secret', 'utf8');
      await approveRoot(handlers, storage, approved);

      expect(await handlers.listDirectory(outside)).toMatchObject({ ok: false });
      expect(await handlers.statEntry(outsideFile)).toMatchObject({ ok: false });
      expect(await handlers.readFile(outsideFile)).toMatchObject({ ok: false });
      // With NO approved roots at all, even the (former) root path is refused.
      resetNotesVaultIpcStateForTest();
      expect(await handlers.listDirectory(approved)).toMatchObject({ ok: false });
    });

    it('rejects a read through an in-root symlink whose target escapes the root', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      const outside = await makeDir();
      const outsideFile = path.join(outside, 'secret.md');
      await fsPromises.writeFile(outsideFile, 'secret', 'utf8');
      await fsPromises.symlink(outsideFile, path.join(approved, 'escape.md'));
      await approveRoot(handlers, storage, approved);

      const result = await handlers.readFile(path.join(approved, 'escape.md'));
      expect(result).toMatchObject({ ok: false });
      expect((result as { error: string }).error).toContain('not inside an approved');
    });

    it('lists immediate children with entry metadata and SKIPS symlink children', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      await fsPromises.writeFile(path.join(approved, 'note.md'), '# hi', 'utf8');
      await fsPromises.mkdir(path.join(approved, 'sub'));
      // Both a live and a dangling symlink child must be skipped.
      await fsPromises.symlink(path.join(approved, 'note.md'), path.join(approved, 'live-link.md'));
      await fsPromises.symlink(path.join(approved, 'missing'), path.join(approved, 'dangling'));
      await approveRoot(handlers, storage, approved);

      const result = await handlers.listDirectory(approved);
      if (!result.ok) {
        throw new Error(`listDirectory failed: ${result.error}`);
      }
      const names = result.value.map((entry) => entry.name).sort();
      expect(names).toEqual(['note.md', 'sub']);
      const note = result.value.find((entry) => entry.name === 'note.md');
      expect(note).toMatchObject({ kind: 'file', size: 4 });
      expect(note?.lastModified).toBeGreaterThan(0);
      const sub = result.value.find((entry) => entry.name === 'sub');
      expect(sub).toMatchObject({ kind: 'directory' });
    });

    it('statEntry returns null for a missing entry inside an approved root', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      await approveRoot(handlers, storage, approved);
      expect(await handlers.statEntry(path.join(approved, 'nope.md'))).toEqual({
        ok: true,
        value: null,
      });
    });

    it('reads a contained file as utf8', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      const filePath = path.join(approved, 'note.md');
      await fsPromises.writeFile(filePath, '# hello vault', 'utf8');
      await approveRoot(handlers, storage, approved);
      expect(await handlers.readFile(filePath)).toEqual({ ok: true, value: '# hello vault' });
    });
  });

  describe('writeFile', () => {
    it('refuses a write outside every approved root', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      const outside = await makeDir();
      await approveRoot(handlers, storage, approved);

      const target = path.join(outside, 'evil.md');
      const result = await handlers.writeFile(target, 'nope');
      expect(result).toMatchObject({ ok: false });
      expect((result as { error: string }).error).toContain('not inside an approved');
      await expect(fsPromises.access(target)).rejects.toThrow();
    });

    it('refuses a traversal escape and the vault root itself', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      const outside = await makeDir();
      await approveRoot(handlers, storage, approved);

      expect(
        await handlers.writeFile(path.join(approved, '..', path.basename(outside), 'evil.md'), 'x')
      ).toMatchObject({ ok: false });
      expect(await handlers.writeFile(approved, 'x')).toMatchObject({ ok: false });
      expect(await handlers.writeFile(path.join(approved, 'note.md'), 42)).toMatchObject({
        ok: false,
      });
    });

    it('writes a contained file into an existing folder and returns its lastModified', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      await fsPromises.mkdir(path.join(approved, 'folder'));
      await approveRoot(handlers, storage, approved);

      const target = path.join(approved, 'folder', 'note.md');
      const result = await handlers.writeFile(target, '# body');
      if (!result.ok) {
        throw new Error(`writeFile failed: ${result.error}`);
      }
      expect(result.value.lastModified).toBeGreaterThan(0);
      expect(await fsPromises.readFile(target, 'utf8')).toBe('# body');

      // Overwrite through the same audited path.
      const rewrite = await handlers.writeFile(target, '# body v2');
      expect(rewrite).toMatchObject({ ok: true });
      expect(await fsPromises.readFile(target, 'utf8')).toBe('# body v2');
    });

    it('refuses a write whose parent folder is gone — never recreates a renamed/deleted directory', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      const folder = path.join(approved, 'folder');
      await fsPromises.mkdir(folder);
      await approveRoot(handlers, storage, approved);
      const target = path.join(folder, 'note.md');
      expect(await handlers.writeFile(target, 'draft')).toMatchObject({ ok: true });

      // Simulate a folder rename/delete racing a stale-path editor autosave:
      // the write must FAIL LOUDLY, not silently mkdir the old folder back.
      await fsPromises.rm(folder, { force: true, recursive: true });
      const stale = await handlers.writeFile(target, 'stale draft');
      expect(stale).toMatchObject({ ok: false });
      expect((stale as { error: string }).error).toContain('no longer exists');
      await expect(fsPromises.access(folder)).rejects.toThrow();
    });

    it('refuses to write through a symlink leaf', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      const outside = await makeDir();
      const outsideFile = path.join(outside, 'target.md');
      await fsPromises.writeFile(outsideFile, 'original', 'utf8');
      await fsPromises.symlink(outsideFile, path.join(approved, 'link.md'));
      await approveRoot(handlers, storage, approved);

      expect(await handlers.writeFile(path.join(approved, 'link.md'), 'evil')).toMatchObject({
        ok: false,
      });
      expect(await fsPromises.readFile(outsideFile, 'utf8')).toBe('original');
    });
  });

  describe('createDirectory', () => {
    it('creates a contained directory (including missing parents) under an approved root', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      await approveRoot(handlers, storage, approved);

      const target = path.join(approved, 'projects', 'ideas');
      expect(await handlers.createDirectory(target)).toEqual({ ok: true, value: null });
      expect((await fsPromises.lstat(target)).isDirectory()).toBe(true);
    });

    it('refuses when an entry already exists at the path (directory OR file)', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      await approveRoot(handlers, storage, approved);
      await fsPromises.mkdir(path.join(approved, 'existing-dir'));
      await fsPromises.writeFile(path.join(approved, 'existing.md'), 'x', 'utf8');

      const dirResult = await handlers.createDirectory(path.join(approved, 'existing-dir'));
      expect(dirResult).toMatchObject({ ok: false });
      expect((dirResult as { error: string }).error).toContain('already exists');
      expect(await handlers.createDirectory(path.join(approved, 'existing.md'))).toMatchObject({
        ok: false,
      });
      // The root itself is an "already exists" refusal too, never an mkdir.
      expect(await handlers.createDirectory(approved)).toMatchObject({ ok: false });
    });

    it('refuses a directory outside every approved root', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      const outside = await makeDir();
      await approveRoot(handlers, storage, approved);

      const target = path.join(outside, 'sneaky');
      const result = await handlers.createDirectory(target);
      expect(result).toMatchObject({ ok: false });
      expect((result as { error: string }).error).toContain('not inside an approved');
      await expect(fsPromises.access(target)).rejects.toThrow();
      // A traversal that lexically escapes the approved root is refused too.
      expect(
        await handlers.createDirectory(path.join(approved, '..', path.basename(outside), 'sneaky'))
      ).toMatchObject({ ok: false });
    });
  });

  describe('deleteEntry', () => {
    it('moves a contained entry to the OS trash via the injected trashItem (never fs unlink)', async () => {
      const { handlers, storage, trashItem } = createHandlers();
      const approved = await makeDir();
      const filePath = path.join(approved, 'note.md');
      await fsPromises.writeFile(filePath, '# bye', 'utf8');
      await approveRoot(handlers, storage, approved);

      expect(await handlers.deleteEntry(filePath, { recursive: false })).toEqual({
        ok: true,
        value: null,
      });
      expect(trashItem).toHaveBeenCalledTimes(1);
      expect(trashItem).toHaveBeenCalledWith(filePath);
      // The handler itself never touches fs: with the trash faked, the file
      // is still on disk (deletion is the OS trash's job, not fs.rm's).
      expect(await fsPromises.readFile(filePath, 'utf8')).toBe('# bye');
    });

    it('refuses to trash an approved vault root itself', async () => {
      const { handlers, storage, trashItem } = createHandlers();
      const approved = await makeDir();
      await approveRoot(handlers, storage, approved);

      const result = await handlers.deleteEntry(approved, { recursive: true });
      expect(result).toMatchObject({ ok: false });
      expect((result as { error: string }).error).toContain('root');
      expect(trashItem).not.toHaveBeenCalled();
    });

    it('refuses paths outside every approved root', async () => {
      const { handlers, storage, trashItem } = createHandlers();
      const approved = await makeDir();
      const outside = await makeDir();
      const outsideFile = path.join(outside, 'keep.md');
      await fsPromises.writeFile(outsideFile, 'keep', 'utf8');
      await approveRoot(handlers, storage, approved);

      const result = await handlers.deleteEntry(outsideFile, { recursive: false });
      expect(result).toMatchObject({ ok: false });
      expect((result as { error: string }).error).toContain('not inside an approved');
      expect(trashItem).not.toHaveBeenCalled();
      expect(await fsPromises.readFile(outsideFile, 'utf8')).toBe('keep');
    });

    it('refuses a symlink leaf — never trashes the symlink TARGET', async () => {
      const { handlers, storage, trashItem } = createHandlers();
      const approved = await makeDir();
      const outside = await makeDir();
      const outsideFile = path.join(outside, 'precious.md');
      const insideFile = path.join(approved, 'real.md');
      await fsPromises.writeFile(outsideFile, 'precious', 'utf8');
      await fsPromises.writeFile(insideFile, 'real', 'utf8');
      await fsPromises.symlink(outsideFile, path.join(approved, 'link-out.md'));
      await fsPromises.symlink(insideFile, path.join(approved, 'link-in.md'));
      await approveRoot(handlers, storage, approved);

      // A symlink pointing OUTSIDE the root: realpath-based resolution would
      // dereference it and trash the target — must refuse instead.
      const outLink = await handlers.deleteEntry(path.join(approved, 'link-out.md'), {
        recursive: false,
      });
      expect(outLink).toMatchObject({ ok: false });
      expect((outLink as { error: string }).error).toContain('symlink');
      // A symlink pointing at another contained note is refused too.
      const inLink = await handlers.deleteEntry(path.join(approved, 'link-in.md'), {
        recursive: false,
      });
      expect(inLink).toMatchObject({ ok: false });
      expect((inLink as { error: string }).error).toContain('symlink');
      expect(trashItem).not.toHaveBeenCalled();
      expect(await fsPromises.readFile(outsideFile, 'utf8')).toBe('precious');
      expect(await fsPromises.readFile(insideFile, 'utf8')).toBe('real');
      expect((await fsPromises.lstat(path.join(approved, 'link-out.md'))).isSymbolicLink()).toBe(
        true
      );
    });

    it('refuses a missing entry and a malformed recursive flag', async () => {
      const { handlers, storage, trashItem } = createHandlers();
      const approved = await makeDir();
      await approveRoot(handlers, storage, approved);

      const missing = await handlers.deleteEntry(path.join(approved, 'nope.md'), {
        recursive: false,
      });
      expect(missing).toMatchObject({ ok: false });
      expect((missing as { error: string }).error).toContain('does not exist');
      expect(
        await handlers.deleteEntry(path.join(approved, 'nope.md'), { recursive: 'yes' })
      ).toMatchObject({ ok: false });
      expect(await handlers.deleteEntry(path.join(approved, 'nope.md'), undefined)).toMatchObject({
        ok: false,
      });
      expect(trashItem).not.toHaveBeenCalled();
    });
  });

  describe('rename', () => {
    it('renames a contained entry within its directory (file AND directory)', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      const fromFile = path.join(approved, 'draft.md');
      await fsPromises.writeFile(fromFile, '# draft', 'utf8');
      await fsPromises.mkdir(path.join(approved, 'old-folder'));
      await approveRoot(handlers, storage, approved);

      const toFile = path.join(approved, 'final.md');
      expect(await handlers.rename(fromFile, toFile)).toEqual({ ok: true, value: null });
      expect(await fsPromises.readFile(toFile, 'utf8')).toBe('# draft');
      await expect(fsPromises.access(fromFile)).rejects.toThrow();

      expect(
        await handlers.rename(path.join(approved, 'old-folder'), path.join(approved, 'new-folder'))
      ).toEqual({ ok: true, value: null });
      expect((await fsPromises.lstat(path.join(approved, 'new-folder'))).isDirectory()).toBe(true);
    });

    it('allows a case-only rename of the same entry (case-insensitive filesystems)', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      const fromFile = path.join(approved, 'Note.md');
      await fsPromises.writeFile(fromFile, '# body', 'utf8');
      await approveRoot(handlers, storage, approved);

      // On a case-insensitive/case-preserving fs (default macOS), the
      // destination lstat resolves to the SOURCE inode — that must not be
      // treated as an existing-destination collision.
      expect(await handlers.rename(fromFile, path.join(approved, 'note.md'))).toEqual({
        ok: true,
        value: null,
      });
      const names = await fsPromises.readdir(approved);
      expect(names).toContain('note.md');
      expect(names).not.toContain('Note.md');
      expect(await fsPromises.readFile(path.join(approved, 'note.md'), 'utf8')).toBe('# body');
    });

    it('refuses to overwrite an existing destination', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      const fromFile = path.join(approved, 'a.md');
      const toFile = path.join(approved, 'b.md');
      await fsPromises.writeFile(fromFile, 'A', 'utf8');
      await fsPromises.writeFile(toFile, 'B', 'utf8');
      await approveRoot(handlers, storage, approved);

      const result = await handlers.rename(fromFile, toFile);
      expect(result).toMatchObject({ ok: false });
      expect((result as { error: string }).error).toContain('already exists');
      // Neither side was touched.
      expect(await fsPromises.readFile(fromFile, 'utf8')).toBe('A');
      expect(await fsPromises.readFile(toFile, 'utf8')).toBe('B');
    });

    it('refuses a cross-directory move (same-directory rename only)', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      const fromFile = path.join(approved, 'a.md');
      await fsPromises.writeFile(fromFile, 'A', 'utf8');
      await fsPromises.mkdir(path.join(approved, 'sub'));
      await approveRoot(handlers, storage, approved);

      const result = await handlers.rename(fromFile, path.join(approved, 'sub', 'a.md'));
      expect(result).toMatchObject({ ok: false });
      expect((result as { error: string }).error).toContain('same-directory');
      expect(await fsPromises.readFile(fromFile, 'utf8')).toBe('A');
    });

    it('refuses paths outside every approved root (either side) and a symlink source', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      const outside = await makeDir();
      const outsideFile = path.join(outside, 'a.md');
      await fsPromises.writeFile(outsideFile, 'A', 'utf8');
      await fsPromises.writeFile(path.join(approved, 'in.md'), 'in', 'utf8');
      await fsPromises.symlink(outsideFile, path.join(approved, 'link.md'));
      await approveRoot(handlers, storage, approved);

      const fromOutside = await handlers.rename(outsideFile, path.join(outside, 'b.md'));
      expect(fromOutside).toMatchObject({ ok: false });
      expect((fromOutside as { error: string }).error).toContain('not inside an approved');
      // A missing source inside the root is a refusal, not a throw.
      expect(
        await handlers.rename(path.join(approved, 'nope.md'), path.join(approved, 'yep.md'))
      ).toMatchObject({ ok: false });
      // A symlink source leaf is refused, and the link stays put.
      const symlinkResult = await handlers.rename(
        path.join(approved, 'link.md'),
        path.join(approved, 'renamed-link.md')
      );
      expect(symlinkResult).toMatchObject({ ok: false });
      expect((symlinkResult as { error: string }).error).toContain('symlink');
      expect((await fsPromises.lstat(path.join(approved, 'link.md'))).isSymbolicLink()).toBe(true);
      expect(await fsPromises.readFile(outsideFile, 'utf8')).toBe('A');
    });
  });

  describe('ensureDefaultVault', () => {
    it('creates the default vault, seeds Welcome.md ONLY on first creation, and approves it', async () => {
      const parent = await makeDir();
      const { handlers } = createHandlers({ getDefaultVaultParentPath: () => parent });

      const first = await handlers.ensureDefaultVault();
      const vaultPath = path.join(parent, DEFAULT_NOTES_VAULT_DIRECTORY_NAME);
      expect(first).toEqual({
        ok: true,
        value: { name: DEFAULT_NOTES_VAULT_DIRECTORY_NAME, path: vaultPath },
      });
      const welcomePath = path.join(vaultPath, 'Welcome.md');
      expect(await fsPromises.readFile(welcomePath, 'utf8')).toContain('# Welcome to Notes');
      expect(approvedNotesVaultRootCountForTest()).toBe(1);

      // A user who deletes the welcome note never sees it again.
      await fsPromises.rm(welcomePath);
      const second = await handlers.ensureDefaultVault();
      expect(second).toEqual(first);
      await expect(fsPromises.access(welcomePath)).rejects.toThrow();
      expect(approvedNotesVaultRootCountForTest()).toBe(1);
    });

    it('refuses a symlinked or non-directory default vault path', async () => {
      const parent = await makeDir();
      const elsewhere = await makeDir();
      const vaultPath = path.join(parent, DEFAULT_NOTES_VAULT_DIRECTORY_NAME);
      await fsPromises.symlink(elsewhere, vaultPath);
      const { handlers } = createHandlers({ getDefaultVaultParentPath: () => parent });
      expect(await handlers.ensureDefaultVault()).toMatchObject({ ok: false });
      expect(approvedNotesVaultRootCountForTest()).toBe(0);
    });
  });

  describe('watch lifecycle', () => {
    it('watches an approved directory and pushes { watchId } to the OWNING renderer only', async () => {
      const { handlers, storage, watchHarness } = createHandlers();
      const approved = await makeDir();
      await approveRoot(handlers, storage, approved);
      const owner = new FakeWebContents(11);

      const result = await handlers.watch(castOwner(owner), approved);
      if (!result.ok) {
        throw new Error(`watch failed: ${result.error}`);
      }
      expect(watchHarness.startedPaths).toEqual([approved]);
      expect(liveNotesVaultWatcherCountForTest()).toBe(1);

      watchHarness.fireAllChanges();
      expect(owner.changedEvents).toEqual([{ watchId: result.value.watchId }]);

      // Destroyed owners never receive pushes.
      owner.fireDestroyed();
      watchHarness.fireAllChanges();
      expect(owner.changedEvents).toHaveLength(1);
    });

    it('refuses to watch a path outside every approved root', async () => {
      const { handlers, watchHarness } = createHandlers();
      const outside = await makeDir();
      const owner = new FakeWebContents(12);
      expect(await handlers.watch(castOwner(owner), outside)).toMatchObject({ ok: false });
      expect(watchHarness.startedPaths).toEqual([]);
      expect(liveNotesVaultWatcherCountForTest()).toBe(0);
    });

    it('does not register a watcher when native subscription setup fails', async () => {
      const { handlers, storage } = createHandlers({
        startWatch: () => Promise.reject(new Error('watcher backend exploded')),
      });
      const approved = await makeDir();
      await approveRoot(handlers, storage, approved);
      const owner = new FakeWebContents(13);

      const result = await handlers.watch(castOwner(owner), approved);

      expect(result).toEqual({ error: 'watcher backend exploded', ok: false });
      expect(liveNotesVaultWatcherCountForTest()).toBe(0);
    });

    it('stops a subscription that becomes healthy after its owner is destroyed', async () => {
      let resolveStart: ((stop: () => void) => void) | undefined;
      const stop = vi.fn();
      const startWatch = vi.fn(
        () =>
          new Promise<() => void>((resolve) => {
            resolveStart = resolve;
          })
      );
      const { handlers, storage } = createHandlers({ startWatch });
      const approved = await makeDir();
      await approveRoot(handlers, storage, approved);
      const owner = new FakeWebContents(14);

      const watchResult = handlers.watch(castOwner(owner), approved);
      await vi.waitFor(() => {
        expect(startWatch).toHaveBeenCalledOnce();
      });
      owner.fireDestroyed();
      resolveStart?.(stop);

      expect(await watchResult).toEqual({
        error: 'Notes vault watcher owner was destroyed during setup.',
        ok: false,
      });
      expect(stop).toHaveBeenCalledOnce();
      expect(liveNotesVaultWatcherCountForTest()).toBe(0);
    });

    it('unwatch stops the watcher for the owner and rejects non-owners with the same error', async () => {
      const { handlers, storage, watchHarness } = createHandlers();
      const approved = await makeDir();
      await approveRoot(handlers, storage, approved);
      const owner = new FakeWebContents(21);

      const watched = await handlers.watch(castOwner(owner), approved);
      if (!watched.ok) {
        throw new Error(`watch failed: ${watched.error}`);
      }
      const { watchId } = watched.value;

      const foreign = handlers.unwatch(watchId, 999);
      expect(foreign).toMatchObject({ ok: false });
      const unknown = handlers.unwatch('notes-watch-nope', 21);
      expect(unknown).toMatchObject({ ok: false });
      // Non-owner and unknown ids share the same error shape (no oracle).
      expect((foreign as { error: string }).error).toContain('No live notes vault watcher');
      expect(liveNotesVaultWatcherCountForTest()).toBe(1);

      expect(handlers.unwatch(watchId, 21)).toEqual({ ok: true, value: null });
      expect(watchHarness.stops[0]).toHaveBeenCalledTimes(1);
      expect(liveNotesVaultWatcherCountForTest()).toBe(0);
      expect(handlers.unwatch(watchId, 21)).toMatchObject({ ok: false });
    });

    it('reaps every watcher owned by a destroyed WebContents', async () => {
      const { handlers, storage, watchHarness } = createHandlers();
      const approvedA = await makeDir();
      const approvedB = await makeDir();
      await approveRoot(handlers, storage, approvedA);
      await approveRoot(handlers, storage, approvedB);
      const owner = new FakeWebContents(31);
      const survivor = new FakeWebContents(32);

      expect(await handlers.watch(castOwner(owner), approvedA)).toMatchObject({ ok: true });
      expect(await handlers.watch(castOwner(owner), approvedB)).toMatchObject({ ok: true });
      expect(await handlers.watch(castOwner(survivor), approvedA)).toMatchObject({ ok: true });
      expect(liveNotesVaultWatcherCountForTest()).toBe(3);

      owner.fireDestroyed();
      expect(liveNotesVaultWatcherCountForTest()).toBe(1);
      expect(watchHarness.stops[0]).toHaveBeenCalledTimes(1);
      expect(watchHarness.stops[1]).toHaveBeenCalledTimes(1);
      expect(watchHarness.stops[2]).not.toHaveBeenCalled();
    });

    it('disposeAllNotesVaultWatchers reaps every live watcher', async () => {
      const { handlers, storage, watchHarness } = createHandlers();
      const approved = await makeDir();
      await approveRoot(handlers, storage, approved);
      const owner = new FakeWebContents(41);
      expect(await handlers.watch(castOwner(owner), approved)).toMatchObject({ ok: true });
      expect(await handlers.watch(castOwner(owner), approved)).toMatchObject({ ok: true });

      expect(disposeAllNotesVaultWatchers()).toBe(2);
      expect(liveNotesVaultWatcherCountForTest()).toBe(0);
      for (const stop of watchHarness.stops) {
        expect(stop).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('registration', () => {
    it('registers the twelve invoke channels (NOT the changed push) and the disposer reaps state', async () => {
      const { handlers, storage } = createHandlers();
      const approved = await makeDir();
      await approveRoot(handlers, storage, approved);
      const owner = new FakeWebContents(51);
      expect(await handlers.watch(castOwner(owner), approved)).toMatchObject({ ok: true });

      const dispose = registerNotesVaultIpcHandlers(handlers);
      const { changed, ...invokeChannels } = DESKTOP_IPC_CHANNELS.notesVault;
      const expectedChannels = Object.values(invokeChannels);
      expect(expectedChannels).toHaveLength(12);
      for (const channel of expectedChannels) {
        expect(registeredHandlers.has(channel)).toBe(true);
      }
      // The changed channel is a one-way main→renderer push, never handled.
      expect(registeredHandlers.has(changed)).toBe(false);

      // Invoke path smoke: listDirectory through the registered handler.
      const listResult = await registeredHandlers.get(
        DESKTOP_IPC_CHANNELS.notesVault.listDirectory
      )?.({} as IpcMainInvokeEvent, approved);
      expect(listResult).toMatchObject({ ok: true });

      dispose();
      expect(registeredHandlers.size).toBe(0);
      expect(liveNotesVaultWatcherCountForTest()).toBe(0);
      expect(approvedNotesVaultRootCountForTest()).toBe(0);
    });
  });
});
