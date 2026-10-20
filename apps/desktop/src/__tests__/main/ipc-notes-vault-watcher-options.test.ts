import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  NotesVaultIpcHandlersOptions,
  NotesVaultRootsStorage,
} from '../../notes-vault-ipc-handlers';

const notesWatcherComposition = vi.hoisted(() => ({
  startJoinedParcelWatch: vi.fn(),
  startWatch: null as NotesVaultIpcHandlersOptions['startWatch'] | null,
}));

vi.mock('@brainstrike/file-system/native-watch', () => ({
  startJoinedParcelWatch: notesWatcherComposition.startJoinedParcelWatch,
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/documents') },
  dialog: { showOpenDialog: vi.fn() },
  shell: { trashItem: vi.fn() },
}));

vi.mock('../../notes-vault-ipc-handlers', () => ({
  createNotesVaultIpcHandlers: vi.fn((options: NotesVaultIpcHandlersOptions) => {
    notesWatcherComposition.startWatch = options.startWatch;
    return {};
  }),
  registerNotesVaultIpcHandlers: vi.fn(() => () => Promise.resolve()),
}));

import { registerNotesVaultIpc } from '../../ipc-notes-vault';

describe('Notes Vault watcher composition', () => {
  beforeEach(() => {
    notesWatcherComposition.startWatch = null;
    notesWatcherComposition.startJoinedParcelWatch.mockReset();
  });

  it('uses the joined native producer with default native filtering and the change callback', async () => {
    const stop = vi.fn(() => Promise.resolve());
    notesWatcherComposition.startJoinedParcelWatch.mockResolvedValue(stop);
    const onChange = vi.fn();
    const unregister = registerNotesVaultIpc({} as NotesVaultRootsStorage);

    expect(notesWatcherComposition.startWatch).not.toBeNull();
    const watchPromise = notesWatcherComposition.startWatch?.('/notes', onChange);

    // BST-2244: the joined producer's disposer settles once the native
    // unsubscribe has, so the shutdown dispose can join it.
    expect(notesWatcherComposition.startJoinedParcelWatch).toHaveBeenCalledWith(
      { kind: 'directory', name: 'notes', path: '/notes', platform: 'electron' },
      expect.any(Function),
      { reportDefaultFilteredChanges: false }
    );
    const change = notesWatcherComposition.startJoinedParcelWatch.mock.calls[0]?.[1] as
      | (() => void)
      | undefined;
    change?.();
    expect(onChange).toHaveBeenCalledOnce();
    await expect(watchPromise).resolves.toBe(stop);
    await unregister();
  });
});
