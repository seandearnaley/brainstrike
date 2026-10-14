/**
 * The Conversation Rewind confirm modal (BST-1115, W5 T4).
 *
 * MULTI-ROOT BAR: every preview here spans TWO workspace roots plus one file
 * outside any repository (`repositoryRoot: null`), and the outcome assertions
 * require all three to be NAMED — a root communicated by absence is the exact
 * failure this bar exists to forbid.
 *
 * The tests that matter most are the negative ones: the gate must be
 * unclickable while a conflict is unacknowledged, `conversation-only` must
 * never carry an acknowledgment it did not need, and a composer must not be
 * repopulated from a target that has no prompt.
 */
import { useRewindComposerStore } from '@brainstrike/assistant-ui/rewind-composer-store';
import { createTestActionRegistry } from '@brainstrike/context-actions';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import {
  FILE_EXPLORER_REFRESH_EVENT,
  type FileExplorerRefreshEvent,
} from '@brainstrike/file-explorer-ui/shell';
import type {
  ChangedFileEntry,
  ChangesetView,
  FileSystemAdapter,
  GitResult,
  WatcherRootHealthEvent,
} from '@brainstrike/types';
import { ActionRegistryProvider, resetToastStore, Toaster } from '@brainstrike/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { useChangesStore } from '../changes-store';
import type {
  RewindApplyResult,
  RewindConflictModel,
  RewindPort,
  RewindPreviewModel,
  RewindRedoResult,
} from '../rewind-port';
import { useRewindStore } from '../rewind-store';
import { RewindConfirmDialog } from '../ui/rewind-confirm-dialog';

// `useRootLabelById` reads the shared FileSystemProvider instance, which this
// suite deliberately does not mount (the dialog tests exercise the rewind
// flow, not root-handle plumbing). Production always mounts the provider
// above the dialog (`AppLayout`). Fixed labels keep the tree deterministic.
// (vi.mock is hoisted above the imports by vitest.)
vi.mock('../use-root-labels', () => ({
  useRootLabelById: () =>
    new Map([
      ['root-repo-a', 'Repo A'],
      ['root-repo-b', 'Repo B'],
      ['root-plain-c', 'Scratch'],
    ]),
}));

const ROOT_A = 'root-repo-a';
const ROOT_B = 'root-repo-b';
const ROOT_PLAIN = 'root-plain-c';

function file(rootId: string, path: string, repositoryRoot: string | null): ChangedFileEntry {
  return {
    additions: null,
    deletions: null,
    path,
    repositoryRoot,
    revertible: true,
    rootId,
    status: 'modified',
    worktreePath: null,
  };
}

const VIEW: ChangesetView = {
  changeset: { fromRunId: 'run-1', kind: 'run-range', threadId: 'thread-1' },
  files: [
    file(ROOT_A, 'src/index.ts', '/repo-a'),
    file(ROOT_B, 'src/index.ts', '/repo-b'),
    file(ROOT_PLAIN, 'notes/scratch.md', null),
  ],
  totalAdditions: null,
  totalDeletions: null,
};

function preview(
  overrides: Partial<Extract<RewindPreviewModel, { ok: true }>> = {}
): RewindPreviewModel {
  return {
    changeset: { fromRunId: 'run-1', kind: 'run-range', threadId: 'thread-1' },
    conflicts: [],
    conversation: { kind: 'branched', turns: 2 },
    filesScope: { available: true },
    messageId: 'msg-2',
    noRecordedEdits: false,
    ok: true,
    previewId: 'preview-1',
    restoreRoots: [
      { rootId: ROOT_A, rootPath: '/repo-a' },
      { rootId: ROOT_B, rootPath: '/repo-b' },
      { rootId: ROOT_PLAIN, rootPath: '/plain-c' },
    ],
    threadId: 'thread-1',
    view: VIEW,
    ...overrides,
  };
}

function conflict(rootId: string, path: string, rootLabel: string): RewindConflictModel {
  return {
    forceable: true,
    message: 'the file changed on disk since the agent wrote it',
    path,
    rootId,
    rootLabel,
  };
}

const APPLIED = {
  ok: true,
  outcome: {
    conversation: { kind: 'branched', turns: 2 },
    notRestored: [],
    roots: [
      {
        attempted: 1,
        conflicts: 0,
        failed: 0,
        label: 'Repo A',
        restored: 1,
        rootId: ROOT_A,
        rootPath: '/repo-a',
      },
      {
        attempted: 1,
        conflicts: 0,
        failed: 0,
        label: 'Repo B',
        restored: 1,
        rootId: ROOT_B,
        rootPath: '/repo-b',
      },
      {
        attempted: 1,
        conflicts: 0,
        failed: 0,
        label: 'Scratch',
        restored: 1,
        rootId: ROOT_PLAIN,
        rootPath: '/plain-c',
      },
    ],
  },
  rewindId: 'rewind-1',
} satisfies Extract<RewindApplyResult, { ok: true }>;

let currentPort: RewindPort;
interface PortStub {
  readonly apply: Mock<RewindPort['apply']>;
  readonly preview: Mock<RewindPort['preview']>;
  readonly redo: Mock<RewindPort['redo']>;
}

function installPort(overrides: Partial<PortStub> = {}): PortStub {
  const stub: PortStub = {
    apply: vi.fn(
      async (): Promise<GitResult<RewindApplyResult>> => ({
        ok: true,
        value: APPLIED,
      })
    ),
    preview: vi.fn(
      async (): Promise<GitResult<RewindPreviewModel>> => ({
        ok: true,
        value: preview(),
      })
    ),
    redo: vi.fn(
      async (): Promise<GitResult<RewindRedoResult>> => ({
        ok: true,
        value: {
          description: 'The conversation returned to its previous branch.',
          ok: true,
          roots: [],
        },
      })
    ),
    ...overrides,
  };
  currentPort = {
    ...stub,
    conversation: 'branched',
    fileDiff: vi.fn(async () => ({ error: 'not used', ok: false as const })),
  };
  return stub;
}

function openRewind(composerText: string | null = 'my original prompt'): void {
  useRewindStore.getState().openRewind({
    composerText,
    port: currentPort,
    target: { messageId: 'msg-2', threadId: 'thread-1' },
  });
}

// `ChangedFilesTree` renders through the shared context-action system, so the
// modal must live inside an `ActionRegistryProvider` — as it does in
// `root-layout-content.tsx`.
const testActionRegistry = createTestActionRegistry().registry;

/**
 * The modal also reaches the file-system adapter after a successful apply, to
 * re-enumerate the reverted roots and re-watch a watcher the bulk unlink killed
 * (`use-rewind-explorer-recovery.ts`). `AdaptersProvider` wraps the whole app in
 * BOTH shells (`apps/desktop/src/renderer/main.tsx`, `apps/web/src/main.tsx`),
 * so mirroring it here is the production tree, not a test convenience.
 */
let pushWatcherHealth: ((event: WatcherRootHealthEvent) => void) | null = null;
const retryWatcher = vi.fn(async () => ({ retried: true as const }));

function testFileSystemAdapter(): FileSystemAdapter {
  return {
    onWatcherHealth: (callback: (event: WatcherRootHealthEvent) => void) => {
      pushWatcherHealth = callback;
      return () => undefined;
    },
    platform: 'electron',
    retryWatcher,
  } as unknown as FileSystemAdapter;
}

function renderDialog() {
  return render(
    <AdaptersProvider fileSystemAdapter={testFileSystemAdapter()} storageAdapter={{} as never}>
      <ActionRegistryProvider registry={testActionRegistry}>
        <RewindConfirmDialog />
        <Toaster />
      </ActionRegistryProvider>
    </AdaptersProvider>
  );
}

let refreshEvents: FileExplorerRefreshEvent['detail'][] = [];

function captureRefreshEvent(event: Event): void {
  refreshEvents.push((event as FileExplorerRefreshEvent).detail);
}

beforeEach(() => {
  refreshEvents = [];
  pushWatcherHealth = null;
  retryWatcher.mockClear();
  window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, captureRefreshEvent);
  useRewindStore.getState().reset();
  useChangesStore.getState().reset();
  useRewindComposerStore.getState().consume();
  // Toast state is module-scope: without this, a test that clicks "the redo
  // toast" drives the PREVIOUS test's closure and its own bridge stub is never
  // called — a failure that points nowhere near its cause.
  resetToastStore();
  // RTL's auto-cleanup force-unmounts an OPEN dialog, which skips Radix's
  // scroll-lock restore and leaves `pointer-events: none` on the body. Left
  // behind, that makes every later test's clicks land on nothing — a
  // cross-test false failure with no visible cause. (Closing through the
  // dialog's own `open` prop, which is what the app does, restores it
  // correctly; this only cleans up after the tests that never close it.)
  document.body.removeAttribute('style');
  document.body.removeAttribute('data-scroll-locked');
});

afterEach(() => {
  window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, captureRefreshEvent);
  Reflect.deleteProperty(window as unknown as { changes?: unknown }, 'changes');
  vi.restoreAllMocks();
});

describe('RewindConfirmDialog', () => {
  it('renders nothing until an entry point raises a request', () => {
    installPort();
    renderDialog();

    expect(screen.queryByTestId('rewind-confirm-dialog')).not.toBeInTheDocument();
  });

  it('shows every root of the previewed range, including the out-of-repo file', async () => {
    installPort();
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    await waitFor(() => {
      expect(screen.getByTestId('changed-files-tree')).toBeInTheDocument();
    });
    // All three files get a card — two roots that share the SAME relative path
    // plus one file outside any repository. (Asserted on the diff pane rather
    // than the tree: the tree viewport is virtualized and measures zero height
    // in jsdom, so its rows are a false negative, not evidence.)
    const cards = screen.getAllByTestId('changeset-file-diff-card-header');
    expect(cards).toHaveLength(3);
    expect(cards.map((card) => card.textContent ?? '').join('|')).toContain('scratch.md');
  });

  // ===== Scope choice (Amendment 1 A1.1) =====

  it('pre-selects conversation-and-files, VISIBLY', async () => {
    installPort();
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    expect(screen.getByTestId('rewind-mode-conversation-and-files')).toBeChecked();
    expect(screen.getByTestId('rewind-mode-conversation-only')).not.toBeChecked();
  });

  it('applies the SELECTED mode, and conversation-only performs no file revert', async () => {
    const user = userEvent.setup();
    const bridge = installPort();
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    await user.click(screen.getByTestId('rewind-mode-conversation-only'));
    await waitFor(() => {
      expect(screen.getByTestId('rewind-confirm')).toBeEnabled();
    });
    await user.click(screen.getByTestId('rewind-confirm'));

    await waitFor(() => {
      expect(bridge.apply).toHaveBeenCalledWith({
        acknowledgeConflicts: false,
        mode: 'conversation-only',
        preview: expect.objectContaining({
          messageId: 'msg-2',
          previewId: 'preview-1',
          threadId: 'thread-1',
        }),
      });
    });
  });

  it('hides the open-files warning in conversation-only mode', async () => {
    const user = userEvent.setup();
    installPort();
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    expect(screen.getByTestId('rewind-open-files-notice')).toHaveTextContent(
      'Open files will be updated on disk; unsaved external edits may conflict'
    );

    await user.click(screen.getByTestId('rewind-mode-conversation-only'));

    expect(screen.queryByTestId('rewind-open-files-notice')).not.toBeInTheDocument();
  });

  // ===== Files-scope availability (BST-1164 W7 T3, carried rulings) =====

  it('disables the files scope with the engine reason for a pre-snapshot turn, and applies conversation-only', async () => {
    const user = userEvent.setup();
    const bridge = installPort({
      preview: vi.fn(async () => ({
        ok: true,
        value: preview({
          filesScope: {
            available: false,
            message:
              'This turn predates workspace snapshots, so its files cannot be restored. Only the conversation can be restored.',
          },
          view: null,
        }),
      })),
    });
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    // The files option is VISIBLE but disabled, with the honest reason under
    // it — never silently removed, never silently selected.
    expect(screen.getByTestId('rewind-mode-conversation-and-files')).toBeDisabled();
    expect(screen.getByTestId('rewind-mode-conversation-only')).toBeChecked();
    expect(screen.getByTestId('rewind-files-scope-refusal')).toHaveTextContent(
      'This turn predates workspace snapshots'
    );

    await waitFor(() => {
      expect(screen.getByTestId('rewind-confirm')).toBeEnabled();
    });
    await user.click(screen.getByTestId('rewind-confirm'));

    // The pre-selected files default must NEVER leak into the wire call when
    // the scope is refused: the effective mode is conversation-only.
    await waitFor(() => {
      expect(bridge.apply).toHaveBeenCalledWith({
        acknowledgeConflicts: false,
        mode: 'conversation-only',
        preview: expect.objectContaining({
          messageId: 'msg-2',
          previewId: 'preview-1',
          threadId: 'thread-1',
        }),
      });
    });
  });

  it('renders the snapshot-missing reason the same way for a failed capture', async () => {
    installPort({
      preview: vi.fn(async () => ({
        ok: true,
        value: preview({
          filesScope: {
            available: false,
            message:
              'No workspace snapshot covers this turn (its capture failed), so its files cannot be restored for this range. Only the conversation can be restored.',
          },
          view: null,
        }),
      })),
    });
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    expect(screen.getByTestId('rewind-mode-conversation-and-files')).toBeDisabled();
    expect(screen.getByTestId('rewind-files-scope-refusal')).toHaveTextContent(
      'No workspace snapshot covers this turn'
    );
  });

  // ===== Capture-scope qualifier: REMOVED (BST-1164 T4) =====
  // The snapshot engine captures shell side effects, so the old
  // "shell-created files aren't restored" qualifier became UNTRUE and was
  // deleted with its copy module. These pins keep it from quietly returning.

  it('renders NO shell-capture qualifier anywhere in the files-mode dialog', async () => {
    installPort();
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    expect(screen.queryByTestId('rewind-shell-capture-notice')).not.toBeInTheDocument();
  });

  it('renders NO shell-capture qualifier in the outcome summary after files came back', async () => {
    const user = userEvent.setup();
    installPort();
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    await waitFor(() => {
      expect(screen.getByTestId('rewind-confirm')).toBeEnabled();
    });
    await user.click(screen.getByTestId('rewind-confirm'));

    await screen.findByTestId('rewind-outcome-summary');
    expect(screen.queryByTestId('rewind-outcome-shell-capture-notice')).not.toBeInTheDocument();
  });

  // ===== Explorer/watcher recovery (smoke round 2, defect 2) =====

  it('re-enumerates every reverted root through the overflow refresh pipeline', async () => {
    const user = userEvent.setup();
    installPort();
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    await waitFor(() => {
      expect(screen.getByTestId('rewind-confirm')).toBeEnabled();
    });
    await user.click(screen.getByTestId('rewind-confirm'));

    await waitFor(() => {
      expect(refreshEvents).toHaveLength(1);
    });
    expect(refreshEvents[0]?.scope).toBe('full');
    expect(refreshEvents[0]?.source).toBe('watcher');
    expect(refreshEvents[0]?.roots.map((root) => root.rootId)).toEqual([
      ROOT_A,
      ROOT_B,
      ROOT_PLAIN,
    ]);
  });

  it('re-watches a root whose watcher the bulk revert killed', async () => {
    const user = userEvent.setup();
    installPort();
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    // The documented `errored` contract: the adapter already tore the watch
    // down and NOTHING restarts it, so without this the root would stay
    // unwatched behind a freshly-refreshed tree.
    pushWatcherHealth?.({
      backend: 'fs-events',
      rootPath: '/repo-a',
      state: 'failed',
      timestamp: 1,
      watchId: 'watch-repo-a',
    });
    await waitFor(() => {
      expect(screen.getByTestId('rewind-confirm')).toBeEnabled();
    });
    await user.click(screen.getByTestId('rewind-confirm'));

    await waitFor(() => {
      expect(retryWatcher).toHaveBeenCalledExactlyOnceWith('/repo-a');
    });
  });

  it('refreshes nothing when the apply is refused', async () => {
    const user = userEvent.setup();
    installPort({
      apply: vi.fn(
        async (): Promise<GitResult<RewindApplyResult>> => ({
          ok: true,
          value: {
            conflicts: [],
            message: 'a run is still in flight',
            ok: false,
            redoable: null,
          },
        })
      ),
    });
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    await waitFor(() => {
      expect(screen.getByTestId('rewind-confirm')).toBeEnabled();
    });
    await user.click(screen.getByTestId('rewind-confirm'));

    await screen.findByTestId('rewind-apply-error');
    expect(refreshEvents).toHaveLength(0);
  });

  // ===== The acknowledgment gate =====

  it('BLOCKS Restore until every conflicting path is acknowledged', async () => {
    const user = userEvent.setup();
    const bridge = installPort({
      preview: vi.fn(async () => ({
        ok: true,
        value: preview({
          conflicts: [
            conflict(ROOT_A, 'src/index.ts', 'Repo A'),
            conflict(ROOT_PLAIN, 'notes/scratch.md', 'Scratch'),
          ],
        }),
      })),
    });
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-conflicts');
    expect(screen.getByTestId('rewind-confirm')).toBeDisabled();

    await user.click(screen.getByTestId('rewind-acknowledge-conflicts'));

    await waitFor(() => {
      expect(screen.getByTestId('rewind-confirm')).toBeEnabled();
    });
    await user.click(screen.getByTestId('rewind-confirm'));

    await waitFor(() => {
      expect(bridge.apply).toHaveBeenCalledWith(
        expect.objectContaining({ acknowledgeConflicts: true })
      );
    });
  });

  it('names every conflicting file, DEDUPED across the runs that touched it', async () => {
    installPort({
      preview: vi.fn(async () => ({
        ok: true,
        value: preview({
          conflicts: [
            // The same file, edited by two runs in the range: two records, ONE
            // line for the user.
            conflict(ROOT_A, 'src/index.ts', 'Repo A'),
            conflict(ROOT_A, 'src/index.ts', 'Repo A'),
            // Same RELATIVE path in a different root: a genuinely different
            // file, so it must NOT be collapsed into the one above.
            conflict(ROOT_B, 'src/index.ts', 'Repo B'),
          ],
        }),
      })),
    });
    openRewind();
    renderDialog();

    const list = await screen.findByTestId('rewind-conflict-paths');
    expect(list.children).toHaveLength(2);
    expect(list).toHaveTextContent('Repo A');
    expect(list).toHaveTextContent('Repo B');
    expect(screen.getByTestId('rewind-conflicts')).toHaveTextContent('2 files cannot be restored');
  });

  it('does NOT gate conversation-only on an acknowledgment: nothing reaches disk', async () => {
    const user = userEvent.setup();
    const bridge = installPort({
      preview: vi.fn(async () => ({
        ok: true,
        value: preview({ conflicts: [conflict(ROOT_A, 'src/index.ts', 'Repo A')] }),
      })),
    });
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-conflicts');
    await user.click(screen.getByTestId('rewind-mode-conversation-only'));

    expect(screen.queryByTestId('rewind-conflicts')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('rewind-confirm'));

    await waitFor(() => {
      expect(bridge.apply).toHaveBeenCalledWith(
        expect.objectContaining({ acknowledgeConflicts: false, mode: 'conversation-only' })
      );
    });
  });

  it('re-gates on a LATE refusal and clears the stale acknowledgment', async () => {
    const user = userEvent.setup();
    const lateConflicts = [conflict(ROOT_B, 'src/index.ts', 'Repo B')];
    const bridge = installPort({
      apply: vi.fn(async () => ({
        ok: true,
        value: {
          conflicts: lateConflicts,
          message: '1 file(s) cannot be restored cleanly and nothing was applied',
          ok: false,
          redoable: null,
        },
      })),
    });
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    await waitFor(() => {
      expect(screen.getByTestId('rewind-confirm')).toBeEnabled();
    });
    await user.click(screen.getByTestId('rewind-confirm'));

    // Disk changed between preview and apply: the newly-named path appears and
    // Restore is blocked again, on a FRESH acknowledgment.
    await screen.findByTestId('rewind-apply-error');
    expect(screen.getByTestId('rewind-conflict-paths')).toHaveTextContent('Repo B');
    expect(screen.getByTestId('rewind-acknowledge-conflicts')).not.toBeChecked();
    expect(screen.getByTestId('rewind-confirm')).toBeDisabled();
    expect(bridge.apply).toHaveBeenCalledTimes(1);
  });

  // ===== Post-apply =====

  it('reports EVERY root after applying, including a disconnected one', async () => {
    const user = userEvent.setup();
    installPort({
      apply: vi.fn(async () => ({
        ok: true,
        value: {
          ...APPLIED,
          outcome: {
            ...APPLIED.outcome,
            notRestored: [
              {
                message: 'workspace root is no longer connected',
                path: 'notes/scratch.md',
                rootId: ROOT_PLAIN,
              },
            ],
            roots: [
              ...APPLIED.outcome.roots.slice(0, 2),
              {
                attempted: 1,
                conflicts: 1,
                failed: 1,
                label: 'Scratch',
                restored: 0,
                rootId: ROOT_PLAIN,
                rootPath: null,
              },
            ],
          },
        },
      })),
    });
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    await waitFor(() => {
      expect(screen.getByTestId('rewind-confirm')).toBeEnabled();
    });
    await user.click(screen.getByTestId('rewind-confirm'));

    await screen.findByTestId('rewind-outcome-summary');
    // Absence is never how a root's outcome is communicated.
    expect(screen.getByTestId(`rewind-outcome-root-${ROOT_A}`)).toHaveTextContent(
      '1 of 1 restored'
    );
    expect(screen.getByTestId(`rewind-outcome-root-${ROOT_B}`)).toHaveTextContent(
      '1 of 1 restored'
    );
    const plain = screen.getByTestId(`rewind-outcome-root-${ROOT_PLAIN}`);
    expect(plain).toHaveTextContent('not connected');
    expect(plain).toHaveTextContent('0 of 1 restored');
    // And the file that did not revert is named, not counted.
    expect(screen.getByTestId('rewind-outcome-unreverted')).toHaveTextContent('notes/scratch.md');
  });

  it('offers a redo affordance in a toast, and wires it to redo', async () => {
    const user = userEvent.setup();
    const bridge = installPort();
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    await waitFor(() => {
      expect(screen.getByTestId('rewind-confirm')).toBeEnabled();
    });
    await user.click(screen.getByTestId('rewind-confirm'));

    // The modal's scroll lock drops pointer events on everything behind it,
    // so the toast is reachable once the result panel is dismissed — which is
    // exactly what that panel's "Undo is available from the notification" copy
    // points the user at.
    await screen.findByTestId('rewind-outcome-summary');
    await user.click(screen.getByTestId('rewind-done'));

    // Radix renders the action twice (the second is the screen-reader
    // announcement clone); the visible one is first.
    const [undo] = await screen.findAllByTestId('rewind-undo-toast-action');
    if (!undo) {
      throw new Error('expected the toast to carry a redo affordance');
    }
    // `fireEvent`, not `userEvent`: Radix Toast's swipe handling calls
    // `hasPointerCapture` on the pointer-event target, which jsdom does not
    // implement — userEvent's pointer sequence therefore throws inside the
    // library before the click ever lands. The wiring under test is the
    // action's `onClick`, which a plain click exercises exactly.
    fireEvent.click(undo);

    await waitFor(() => {
      // The FIRST redo attempt is always an honest pre-scan, never a blind
      // force — `acknowledgeConflicts` is explicit-false until a
      // `conflicts-unacknowledged` refusal's own retry action sends `true`.
      expect(bridge.redo).toHaveBeenCalledWith({
        acknowledgeConflicts: false,
        rewindId: 'rewind-1',
        roots: APPLIED.outcome.roots,
        threadId: 'thread-1',
      });
    });
  });

  it('a conflicted redo is not a dead end: the toast carries its own force-retry action', async () => {
    const user = userEvent.setup();
    let redoCalls = 0;
    const bridge = installPort({
      redo: vi.fn(async (): Promise<GitResult<RewindRedoResult>> => {
        redoCalls += 1;
        if (redoCalls === 1) {
          return {
            ok: true,
            value: {
              forceable: true,
              message:
                '1 file(s) cannot be restored cleanly and nothing was applied: src/index.ts. Re-issue with acknowledgeConflicts to proceed.',
              ok: false,
            },
          };
        }
        return {
          ok: true,
          value: {
            description: 'The conversation returned to its previous branch.',
            ok: true,
            roots: [],
          },
        };
      }),
    });
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    await waitFor(() => {
      expect(screen.getByTestId('rewind-confirm')).toBeEnabled();
    });
    await user.click(screen.getByTestId('rewind-confirm'));
    await screen.findByTestId('rewind-outcome-summary');
    await user.click(screen.getByTestId('rewind-done'));

    const [undo] = await screen.findAllByTestId('rewind-undo-toast-action');
    if (!undo) {
      throw new Error('expected the toast to carry a redo affordance');
    }
    fireEvent.click(undo);

    // The FIRST redo refuses. Rather than a permanent dead end, the SAME
    // toast now offers a scoped force-retry — not a blanket override, only
    // for the conflicts THIS refusal just named.
    const [forceRetry] = await screen.findAllByTestId('rewind-redo-force-toast-action');
    if (!forceRetry) {
      throw new Error('expected the conflicted redo toast to carry a force-retry action');
    }
    fireEvent.click(forceRetry);

    await waitFor(() => {
      expect(redoCalls).toBe(2);
    });
    expect(bridge.redo).toHaveBeenNthCalledWith(1, {
      acknowledgeConflicts: false,
      rewindId: 'rewind-1',
      roots: APPLIED.outcome.roots,
      threadId: 'thread-1',
    });
    expect(bridge.redo).toHaveBeenNthCalledWith(2, {
      acknowledgeConflicts: true,
      rewindId: 'rewind-1',
      roots: APPLIED.outcome.roots,
      threadId: 'thread-1',
    });
    await screen.findByText('The conversation returned to its previous branch.');
  });

  // ===== Composer repopulation (Amendment 2) =====

  it('repopulates the composer with the TARGET USER MESSAGE text', async () => {
    const user = userEvent.setup();
    installPort();
    openRewind('my original prompt');
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    await waitFor(() => {
      expect(screen.getByTestId('rewind-confirm')).toBeEnabled();
    });
    await user.click(screen.getByTestId('rewind-confirm'));

    await waitFor(() => {
      expect(useRewindComposerStore.getState().pendingText).toBe('my original prompt');
    });
  });

  /**
   * The re-hydration bump (BST-1115). Without it the apply succeeded, the
   * branch changed, and the user watched an unchanged conversation — the
   * defect the live smoke reported. The COUNTER is the whole contract here: the
   * panel and the Changes surface key their re-read on it.
   *
   * It must be raised BEFORE the composer repopulation, which is why this
   * asserts both in one test: `RewindComposerBridge` lives inside the runtime
   * the bump remounts, so text handed over first would be dropped by the
   * remount that follows it.
   */
  it('bumps the re-hydration generation on a successful apply, before repopulating', async () => {
    const user = userEvent.setup();
    installPort();
    openRewind('my original prompt');
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    await waitFor(() => {
      expect(screen.getByTestId('rewind-confirm')).toBeEnabled();
    });
    expect(useRewindStore.getState().generation).toBe(0);

    await user.click(screen.getByTestId('rewind-confirm'));

    await waitFor(() => expect(useRewindStore.getState().generation).toBe(1));
    // The text is still PENDING: the bump did not consume it, so the remounted
    // composer bridge is the one that drains it.
    expect(useRewindComposerStore.getState().pendingText).toBe('my original prompt');
  });

  it('does NOT bump the generation when the apply is refused', async () => {
    const user = userEvent.setup();
    installPort({
      apply: vi.fn(
        async (): Promise<GitResult<RewindApplyResult>> => ({
          ok: true,
          value: {
            conflicts: [],
            message: 'thread "thread-1" has a run in flight and nothing was applied.',
            ok: false,
            redoable: null,
          },
        })
      ),
    });
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    await waitFor(() => {
      expect(screen.getByTestId('rewind-confirm')).toBeEnabled();
    });
    await user.click(screen.getByTestId('rewind-confirm'));

    // Nothing durable changed, so nothing may be re-read — a bump here would
    // discard the live thread's in-memory state for a rewind that never ran.
    await screen.findByTestId('rewind-apply-error');
    expect(useRewindStore.getState().generation).toBe(0);
  });

  it('bumps the generation again when the rewind is undone', async () => {
    const user = userEvent.setup();
    installPort();
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    await waitFor(() => {
      expect(screen.getByTestId('rewind-confirm')).toBeEnabled();
    });
    await user.click(screen.getByTestId('rewind-confirm'));
    await screen.findByTestId('rewind-outcome-summary');
    await user.click(screen.getByTestId('rewind-done'));

    const [undo] = await screen.findAllByTestId('rewind-undo-toast-action');
    if (!undo) {
      throw new Error('expected the toast to carry a redo affordance');
    }
    fireEvent.click(undo);

    // A redo restores both the messages and the files, so every surface must
    // re-read exactly as it did for the apply.
    await waitFor(() => expect(useRewindStore.getState().generation).toBe(2));
  });

  it('does NOT repopulate when the target carries no prompt', async () => {
    const user = userEvent.setup();
    installPort();
    // `composerText: null` is what an assistant-message target and the
    // run-anchored header entry point both produce.
    openRewind(null);
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    await waitFor(() => {
      expect(screen.getByTestId('rewind-confirm')).toBeEnabled();
    });
    await user.click(screen.getByTestId('rewind-confirm'));

    await screen.findByTestId('rewind-outcome-summary');
    expect(useRewindComposerStore.getState().pendingText).toBeNull();
  });

  // ===== Failure surfacing =====

  it('surfaces a domain refusal instead of a silent no-op', async () => {
    installPort({
      preview: vi.fn(async () => ({
        ok: true,
        value: {
          message: 'message "msg-2" was not found in thread "thread-1".',
          ok: false,
        },
      })),
    });
    openRewind();
    renderDialog();

    expect(await screen.findByTestId('rewind-preview-refused')).toHaveTextContent(
      'was not found in thread'
    );
    expect(screen.getByTestId('rewind-confirm')).toBeDisabled();
  });

  it('surfaces a transport failure distinctly from a refusal', async () => {
    installPort({
      preview: vi.fn(async () => ({ error: 'bridge exploded', ok: false })),
    });
    openRewind();
    renderDialog();

    expect(await screen.findByTestId('rewind-preview-error')).toHaveTextContent('bridge exploded');
    expect(screen.queryByTestId('rewind-preview-refused')).not.toBeInTheDocument();
  });

  it('closes without applying anything on Cancel', async () => {
    const user = userEvent.setup();
    const bridge = installPort();
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    await user.click(screen.getByTestId('rewind-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('rewind-confirm-dialog')).not.toBeInTheDocument();
    });
    expect(bridge.apply).not.toHaveBeenCalled();
    expect(useRewindStore.getState().request).toBeNull();
  });
});
