import { useThreadFolderScopeStore } from '@brainstrike/file-explorer-ui/thread-folder-scope-store';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const explorer = vi.hoisted(() => ({
  active: 'thread-1' as string | null,
  /** The focused root's own selection; in query mode it leaves out the other roots. */
  focused: new Set<string>(),
  rootDescriptors: {
    'adapter-a': { displayName: 'alpha', path: '/work/alpha', rootId: 'adapter-a' },
    'adapter-b': { displayName: 'bravo', path: '/work/bravo', rootId: 'adapter-b' },
  } as Record<string, unknown>,
  /** The whole forest's selection: what the selection bar counts. */
  selected: new Set<string>(),
}));
const toast = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/assistant-data', () => ({
  useActiveAssistantThreadId: () => explorer.active,
}));
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorerStoreSelector: <T,>(selector: (state: typeof explorer) => T): T =>
    selector(explorer),
  useSelectionManager: () => ({
    forestSelection: explorer.selected,
    selectedCount: explorer.selected.size,
    selectedFilePaths: explorer.focused,
  }),
}));
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  toast,
}));

import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import { ExplorerAttachAction } from '../explorer-attach-action';
import { folderRelativePath, MAX_ATTACHED_FILES, planAttachment } from '../explorer-attach-plan';
import { RootIdentityProvider } from '../roots/root-identity-context';

const identity = new Map([
  ['adapter-a', 'root-a'],
  ['adapter-b', 'root-b'],
]);

function Action(): ReactElement {
  return (
    <RootIdentityProvider dbRootIdByAdapterRootId={identity}>
      <ExplorerAttachAction />
    </RootIdentityProvider>
  );
}

beforeEach(() => {
  explorer.active = 'thread-1';
  explorer.focused = new Set();
  explorer.selected = new Set();
  toast.mockClear();
  useAssistantComposerCommandStore.getState().reset();
  useThreadFolderScopeStore.getState().reset();
});
afterEach(() => {
  useThreadFolderScopeStore.getState().reset();
});

describe('folderRelativePath', () => {
  it('addresses a file by its path inside its folder, or not at all', () => {
    expect(folderRelativePath('/work/alpha/src/a.ts', '/work/alpha')).toBe('src/a.ts');
    expect(folderRelativePath('/work/alpha/src/a.ts', '/work/alpha/')).toBe('src/a.ts');
    expect(folderRelativePath('src/a.ts', 'alpha')).toBe('src/a.ts');
    expect(folderRelativePath('/src/a.ts', 'alpha')).toBeNull();
    expect(folderRelativePath('/work/alphabet/a.ts', '/work/alpha')).toBeNull();
    expect(folderRelativePath('C:\\work\\alpha\\a.ts', 'C:\\work\\alpha')).toBe('a.ts');
  });
});

describe('planAttachment', () => {
  const roots = {
    'adapter-a': { displayName: 'alpha', path: '/work/alpha' },
    'adapter-b': { displayName: 'bravo', path: '/work/bravo' },
  };
  const resolveDbRootId = (adapterRootId: string) => identity.get(adapterRootId) ?? null;

  it("names each file by the host's identity, and the folders outside the thread", () => {
    const plan = planAttachment(
      [
        'adapter-a|@|/work/alpha/src/a.ts',
        'adapter-b|@|/work/bravo/b.ts',
        'adapter-b|@|/work/bravo/c.ts',
      ],
      { resolveDbRootId, roots, threadRootIds: ['root-a'] }
    );
    expect(plan.mentions).toEqual([
      { id: 'root-a::src/a.ts', label: 'a.ts' },
      { id: 'root-b::b.ts', label: 'b.ts' },
      { id: 'root-b::c.ts', label: 'c.ts' },
    ]);
    expect(plan.outsideFolders).toEqual([
      { displayName: 'bravo', files: 2, path: '/work/bravo', rootId: 'root-b' },
    ]);
    expect(plan.unaddressable).toBe(0);
  });

  it('counts a file whose root is unreconciled or whose path leaves its folder', () => {
    const plan = planAttachment(['adapter-x|@|/x/a.ts', 'adapter-a|@|/elsewhere/a.ts'], {
      resolveDbRootId,
      roots,
      threadRootIds: null,
    });
    expect(plan).toEqual({ mentions: [], outsideFolders: [], unaddressable: 2 });
  });

  it('treats every folder as in scope while the thread has no binding', () => {
    const plan = planAttachment(['adapter-b|@|/work/bravo/b.ts'], {
      resolveDbRootId,
      roots,
      threadRootIds: null,
    });
    expect(plan.outsideFolders).toEqual([]);
  });
});

describe('ExplorerAttachAction', () => {
  it("appends the selected files to the active thread's draft as mentions", () => {
    explorer.selected = new Set(['adapter-a|@|/work/alpha/src/a.ts']);
    render(<Action />);
    fireEvent.click(screen.getByTestId('explorer-attach-to-thread'));
    expect(useAssistantComposerCommandStore.getState().commandsByThreadId['thread-1']).toEqual([
      expect.objectContaining({ mode: 'append', text: ':file[a.ts]{name=root-a::src/a.ts}' }),
    ]);
    expect(toast).not.toHaveBeenCalled();
  });

  it("attaches every root's selected files, not only the focused root's query", () => {
    explorer.focused = new Set(['adapter-a|@|/work/alpha/a.ts']);
    explorer.selected = new Set(['adapter-a|@|/work/alpha/a.ts', 'adapter-b|@|/work/bravo/b.ts']);
    render(<Action />);
    fireEvent.click(screen.getByTestId('explorer-attach-to-thread'));
    expect(useAssistantComposerCommandStore.getState().commandsByThreadId['thread-1']).toEqual([
      expect.objectContaining({
        text: ':file[a.ts]{name=root-a::a.ts} :file[b.ts]{name=root-b::b.ts}',
      }),
    ]);
  });

  it('says a folder is outside the thread, and its action asks the bar to add it', () => {
    useThreadFolderScopeStore
      .getState()
      .publishScope({ rootIds: ['root-a'], threadId: 'thread-1' });
    explorer.selected = new Set(['adapter-b|@|/work/bravo/b.ts']);
    render(<Action />);
    fireEvent.click(screen.getByTestId('explorer-attach-to-thread'));
    expect(toast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ persistent: true, title: 'bravo is not in this thread' })
    );
    const [notice] = toast.mock.calls[0] ?? [];
    render((notice as { action: ReactElement }).action);
    fireEvent.click(screen.getByText('Add to this thread'));
    expect(useThreadFolderScopeStore.getState().pendingAdd).toEqual({
      displayName: 'bravo',
      path: '/work/bravo',
      rootId: 'root-b',
      threadId: 'thread-1',
    });
  });

  it("adds the folder only to the notice's own thread", () => {
    useThreadFolderScopeStore
      .getState()
      .publishScope({ rootIds: ['root-a'], threadId: 'thread-1' });
    explorer.selected = new Set(['adapter-b|@|/work/bravo/b.ts']);
    render(<Action />);
    fireEvent.click(screen.getByTestId('explorer-attach-to-thread'));
    const [notice] = toast.mock.calls[0] ?? [];
    // The user moves to another thread before acting on the notice.
    useThreadFolderScopeStore
      .getState()
      .publishScope({ rootIds: ['root-c'], threadId: 'thread-2' });
    render((notice as { action: ReactElement }).action);
    fireEvent.click(screen.getByText('Add to this thread'));
    expect(useThreadFolderScopeStore.getState().pendingAdd).toBeNull();
    expect(toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'bravo was not added', variant: 'destructive' })
    );
  });

  it('refuses without an active thread, and above the attach limit', () => {
    explorer.active = null;
    explorer.selected = new Set(['adapter-a|@|/work/alpha/a.ts']);
    const { unmount } = render(<Action />);
    fireEvent.click(screen.getByTestId('explorer-attach-to-thread'));
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'No active thread' }));
    unmount();
    explorer.active = 'thread-1';
    explorer.selected = new Set(
      Array.from({ length: MAX_ATTACHED_FILES + 1 }, (_, i) => `adapter-a|@|/work/alpha/${i}.ts`)
    );
    render(<Action />);
    fireEvent.click(screen.getByTestId('explorer-attach-to-thread'));
    expect(toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Too many files to attach' })
    );
    expect(useAssistantComposerCommandStore.getState().commandsByThreadId).toEqual({});
  });
});
