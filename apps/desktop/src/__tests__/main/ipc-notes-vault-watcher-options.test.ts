import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotesVaultRootsStorage } from '../../notes-vault-ipc-handlers';

const notesWatcherComposition = vi.hoisted(() => ({
  change: null as (() => void) | null,
  health: null as
    | ((event: { backend: 'fs-events'; state: 'healthy'; timestamp: number }) => void)
    | null,
  options: null as Record<string, unknown> | null,
  startWatch: null as ((directoryPath: string, onChange: () => void) => Promise<() => void>) | null,
  stop: vi.fn(),
  watchDirectory: vi.fn(
    (
      _handle: unknown,
      onChange: () => void,
      _onSignal: unknown,
      options: {
        onHealth: (event: { backend: 'fs-events'; state: 'healthy'; timestamp: number }) => void;
      }
    ) => {
      notesWatcherComposition.change = onChange;
      notesWatcherComposition.health = options.onHealth;
      notesWatcherComposition.options = options as unknown as Record<string, unknown>;
      return notesWatcherComposition.stop;
    }
  ),
}));

vi.mock('@brainstrike/file-system/electron', () => ({
  ElectronFileSystemAdapter: class {
    watchDirectory = notesWatcherComposition.watchDirectory;
  },
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/documents') },
  dialog: { showOpenDialog: vi.fn() },
  shell: { trashItem: vi.fn() },
}));

vi.mock('../../notes-vault-ipc-handlers', () => ({
  createNotesVaultIpcHandlers: vi.fn(
    (options: {
      startWatch: (directoryPath: string, onChange: () => void) => Promise<() => void>;
    }) => {
      notesWatcherComposition.startWatch = options.startWatch;
      return {};
    }
  ),
  registerNotesVaultIpcHandlers: vi.fn(() => () => undefined),
}));

import { registerNotesVaultIpc } from '../../ipc-notes-vault';

describe('Notes Vault watcher composition', () => {
  beforeEach(() => {
    notesWatcherComposition.change = null;
    notesWatcherComposition.health = null;
    notesWatcherComposition.options = null;
    notesWatcherComposition.startWatch = null;
    notesWatcherComposition.stop.mockClear();
    notesWatcherComposition.watchDirectory.mockClear();
  });

  it('retains default native filtering and the existing change callback', async () => {
    const onChange = vi.fn();
    const unregister = registerNotesVaultIpc({} as NotesVaultRootsStorage);

    expect(notesWatcherComposition.startWatch).not.toBeNull();
    const watchPromise = notesWatcherComposition.startWatch?.('/notes', onChange);

    expect(notesWatcherComposition.options).toEqual(
      expect.objectContaining({ reportDefaultFilteredChanges: false })
    );
    notesWatcherComposition.change?.();
    expect(onChange).toHaveBeenCalledOnce();
    notesWatcherComposition.health?.({ backend: 'fs-events', state: 'healthy', timestamp: 1 });
    await expect(watchPromise).resolves.toBe(notesWatcherComposition.stop);
    unregister();
  });
});
