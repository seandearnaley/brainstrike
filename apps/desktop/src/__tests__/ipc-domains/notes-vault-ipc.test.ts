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
  type NotesVaultChangedEvent,
  type NotesVaultIpcHandlers,
  type NotesVaultIpcHandlersOptions,
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
      return stop;
    },
    stops,
  };
}

function createHandlers(overrides: Partial<NotesVaultIpcHandlersOptions> = {}): {
  handlers: NotesVaultIpcHandlers;
  watchHarness: WatchHarness;
} {
  const watchHarness = createWatchHarness();
  const handlers = createNotesVaultIpcHandlers({
    getDefaultVaultParentPath: () => {
      throw new Error('getDefaultVaultParentPath not configured for this test');
    },
    pickDirectoryPath: () => Promise.resolve(null),
    startWatch: watchHarness.startWatch,
    ...overrides,
  });
  return { handlers, watchHarness };
}

async function approveRoot(handlers: NotesVaultIpcHandlers, rootPath: string): Promise<void> {
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
    it('registers a valid directory root with basename display name', async () => {
      const { handlers } = createHandlers();
      const root = await makeDir();
      const result = await handlers.registerRoot(root);
      expect(result).toEqual({
        ok: true,
        value: { name: path.basename(root), path: root },
      });
      expect(approvedNotesVaultRootCountForTest()).toBe(1);
    });

    it('rejects a missing path, a relative path, and a file root', async () => {
      const { handlers } = createHandlers();
      const root = await makeDir();
      const filePath = path.join(root, 'note.md');
      await fsPromises.writeFile(filePath, 'hi', 'utf8');

      expect(await handlers.registerRoot(path.join(root, 'missing'))).toMatchObject({ ok: false });
      expect(await handlers.registerRoot('relative/path')).toMatchObject({ ok: false });
      expect(await handlers.registerRoot(filePath)).toMatchObject({ ok: false });
      expect(await handlers.registerRoot(42)).toMatchObject({ ok: false });
      expect(approvedNotesVaultRootCountForTest()).toBe(0);
    });

    it('pickDirectory resolves { ok: true, value: null } on user cancel', async () => {
      const { handlers } = createHandlers({ pickDirectoryPath: () => Promise.resolve(null) });
      expect(await handlers.pickDirectory()).toEqual({ ok: true, value: null });
      expect(approvedNotesVaultRootCountForTest()).toBe(0);
    });

    it('pickDirectory registers the picked directory as an approved root', async () => {
      const picked = await makeDir();
      const { handlers } = createHandlers({
        pickDirectoryPath: () => Promise.resolve(picked),
      });
      expect(await handlers.pickDirectory()).toEqual({
        ok: true,
        value: { name: path.basename(picked), path: picked },
      });
      expect(approvedNotesVaultRootCountForTest()).toBe(1);
    });
  });

  describe('read containment', () => {
    it('rejects listDirectory/statEntry/readFile for paths outside every approved root', async () => {
      const { handlers } = createHandlers();
      const approved = await makeDir();
      const outside = await makeDir();
      const outsideFile = path.join(outside, 'secret.md');
      await fsPromises.writeFile(outsideFile, 'secret', 'utf8');
      await approveRoot(handlers, approved);

      expect(await handlers.listDirectory(outside)).toMatchObject({ ok: false });
      expect(await handlers.statEntry(outsideFile)).toMatchObject({ ok: false });
      expect(await handlers.readFile(outsideFile)).toMatchObject({ ok: false });
      // With NO approved roots at all, even the (former) root path is refused.
      resetNotesVaultIpcStateForTest();
      expect(await handlers.listDirectory(approved)).toMatchObject({ ok: false });
    });

    it('rejects a read through an in-root symlink whose target escapes the root', async () => {
      const { handlers } = createHandlers();
      const approved = await makeDir();
      const outside = await makeDir();
      const outsideFile = path.join(outside, 'secret.md');
      await fsPromises.writeFile(outsideFile, 'secret', 'utf8');
      await fsPromises.symlink(outsideFile, path.join(approved, 'escape.md'));
      await approveRoot(handlers, approved);

      const result = await handlers.readFile(path.join(approved, 'escape.md'));
      expect(result).toMatchObject({ ok: false });
      expect((result as { error: string }).error).toContain('not inside an approved');
    });

    it('lists immediate children with entry metadata and SKIPS symlink children', async () => {
      const { handlers } = createHandlers();
      const approved = await makeDir();
      await fsPromises.writeFile(path.join(approved, 'note.md'), '# hi', 'utf8');
      await fsPromises.mkdir(path.join(approved, 'sub'));
      // Both a live and a dangling symlink child must be skipped.
      await fsPromises.symlink(path.join(approved, 'note.md'), path.join(approved, 'live-link.md'));
      await fsPromises.symlink(path.join(approved, 'missing'), path.join(approved, 'dangling'));
      await approveRoot(handlers, approved);

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
      const { handlers } = createHandlers();
      const approved = await makeDir();
      await approveRoot(handlers, approved);
      expect(await handlers.statEntry(path.join(approved, 'nope.md'))).toEqual({
        ok: true,
        value: null,
      });
    });

    it('reads a contained file as utf8', async () => {
      const { handlers } = createHandlers();
      const approved = await makeDir();
      const filePath = path.join(approved, 'note.md');
      await fsPromises.writeFile(filePath, '# hello vault', 'utf8');
      await approveRoot(handlers, approved);
      expect(await handlers.readFile(filePath)).toEqual({ ok: true, value: '# hello vault' });
    });
  });

  describe('writeFile', () => {
    it('refuses a write outside every approved root', async () => {
      const { handlers } = createHandlers();
      const approved = await makeDir();
      const outside = await makeDir();
      await approveRoot(handlers, approved);

      const target = path.join(outside, 'evil.md');
      const result = await handlers.writeFile(target, 'nope');
      expect(result).toMatchObject({ ok: false });
      expect((result as { error: string }).error).toContain('not inside an approved');
      await expect(fsPromises.access(target)).rejects.toThrow();
    });

    it('refuses a traversal escape and the vault root itself', async () => {
      const { handlers } = createHandlers();
      const approved = await makeDir();
      const outside = await makeDir();
      await approveRoot(handlers, approved);

      expect(
        await handlers.writeFile(path.join(approved, '..', path.basename(outside), 'evil.md'), 'x')
      ).toMatchObject({ ok: false });
      expect(await handlers.writeFile(approved, 'x')).toMatchObject({ ok: false });
      expect(await handlers.writeFile(path.join(approved, 'note.md'), 42)).toMatchObject({
        ok: false,
      });
    });

    it('writes a contained file (creating parents) and returns its lastModified', async () => {
      const { handlers } = createHandlers();
      const approved = await makeDir();
      await approveRoot(handlers, approved);

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

    it('refuses to write through a symlink leaf', async () => {
      const { handlers } = createHandlers();
      const approved = await makeDir();
      const outside = await makeDir();
      const outsideFile = path.join(outside, 'target.md');
      await fsPromises.writeFile(outsideFile, 'original', 'utf8');
      await fsPromises.symlink(outsideFile, path.join(approved, 'link.md'));
      await approveRoot(handlers, approved);

      expect(await handlers.writeFile(path.join(approved, 'link.md'), 'evil')).toMatchObject({
        ok: false,
      });
      expect(await fsPromises.readFile(outsideFile, 'utf8')).toBe('original');
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
      const { handlers, watchHarness } = createHandlers();
      const approved = await makeDir();
      await approveRoot(handlers, approved);
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

    it('unwatch stops the watcher for the owner and rejects non-owners with the same error', async () => {
      const { handlers, watchHarness } = createHandlers();
      const approved = await makeDir();
      await approveRoot(handlers, approved);
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
      const { handlers, watchHarness } = createHandlers();
      const approvedA = await makeDir();
      const approvedB = await makeDir();
      await approveRoot(handlers, approvedA);
      await approveRoot(handlers, approvedB);
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
      const { handlers, watchHarness } = createHandlers();
      const approved = await makeDir();
      await approveRoot(handlers, approved);
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
    it('registers the nine invoke channels (NOT the changed push) and the disposer reaps state', async () => {
      const { handlers } = createHandlers();
      const approved = await makeDir();
      await approveRoot(handlers, approved);
      const owner = new FakeWebContents(51);
      expect(await handlers.watch(castOwner(owner), approved)).toMatchObject({ ok: true });

      const dispose = registerNotesVaultIpcHandlers(handlers);
      const { changed, ...invokeChannels } = DESKTOP_IPC_CHANNELS.notesVault;
      const expectedChannels = Object.values(invokeChannels);
      expect(expectedChannels).toHaveLength(9);
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
