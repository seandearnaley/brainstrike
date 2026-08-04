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
import type {
  AssistantRewindConflict,
  AssistantRewindPreviewResult,
  AssistantRewindRedoResult,
  AssistantRewindResult,
} from '@brainstrike/assistant-contract';
import { createTestActionRegistry } from '@brainstrike/context-actions';
import type { ChangedFileEntry, ChangesetView, GitResult } from '@brainstrike/types';
import { ActionRegistryProvider, resetToastStore, Toaster } from '@brainstrike/ui';
import { useRewindComposerStore } from '@brainstrike/ui/assistant-ui-panel/rewind-composer-store';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangesBridge } from '../changes-bridge';
import { useChangesStore } from '../changes-store';
import { useRewindStore } from '../rewind-store';
import { RewindConfirmDialog } from '../ui/rewind-confirm-dialog';

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
  overrides: Partial<Extract<AssistantRewindPreviewResult, { ok: true }>> = {}
): AssistantRewindPreviewResult {
  return {
    changeset: { fromRunId: 'run-1', kind: 'run-range', threadId: 'thread-1' },
    conflicts: [],
    messageId: 'msg-2',
    ok: true,
    range: { fromRunId: 'run-1', kind: 'runs', runIds: ['run-1', 'run-2'] },
    threadId: 'thread-1',
    tombstoneMessageIds: ['msg-2', 'msg-3'],
    view: VIEW,
    ...overrides,
  };
}

function conflict(rootId: string, path: string, rootLabel: string): AssistantRewindConflict {
  return {
    checkpointId: `cp-${rootId}-${path}`,
    code: 'disk-changed',
    message: 'the file changed on disk since the agent wrote it',
    path,
    rootId,
    rootLabel,
  };
}

const APPLIED: AssistantRewindResult = {
  fileOutcomes: [
    { checkpointId: 'cp-a', code: 'reverted', message: null, path: 'src/index.ts', rootId: ROOT_A },
    { checkpointId: 'cp-b', code: 'reverted', message: null, path: 'src/index.ts', rootId: ROOT_B },
    {
      checkpointId: 'cp-c',
      code: 'reverted',
      message: null,
      path: 'notes/scratch.md',
      rootId: ROOT_PLAIN,
    },
  ],
  mode: 'conversation-and-files',
  ok: true,
  range: { fromRunId: 'run-1', kind: 'runs', runIds: ['run-1'] },
  revertId: 'revert-1',
  rewindId: 'rewind-1',
  rootOutcomes: [
    {
      attempted: 1,
      conflicts: 0,
      failed: 0,
      reverted: 1,
      rootId: ROOT_A,
      rootLabel: 'Repo A',
      rootPath: '/repo-a',
    },
    {
      attempted: 1,
      conflicts: 0,
      failed: 0,
      reverted: 1,
      rootId: ROOT_B,
      rootLabel: 'Repo B',
      rootPath: '/repo-b',
    },
    {
      attempted: 1,
      conflicts: 0,
      failed: 0,
      reverted: 1,
      rootId: ROOT_PLAIN,
      rootLabel: 'Scratch',
      rootPath: '/plain-c',
    },
  ],
  tombstonedMessageIds: ['msg-2', 'msg-3'],
};

interface BridgeStub {
  readonly applyRewind: ReturnType<typeof vi.fn>;
  readonly redoRewind: ReturnType<typeof vi.fn>;
  readonly rewindPreview: ReturnType<typeof vi.fn>;
}

function installBridge(overrides: Partial<BridgeStub> = {}): BridgeStub {
  const stub: BridgeStub = {
    applyRewind: vi.fn(
      async (): Promise<GitResult<AssistantRewindResult>> => ({
        ok: true,
        value: APPLIED,
      })
    ),
    redoRewind: vi.fn(
      async (): Promise<GitResult<AssistantRewindRedoResult>> => ({
        ok: true,
        value: {
          fileOutcomes: [],
          ok: true,
          restoredMessageIds: ['msg-2', 'msg-3'],
          revertId: 'revert-1',
          rewindId: 'rewind-1',
          rootOutcomes: [],
        },
      })
    ),
    rewindPreview: vi.fn(
      async (): Promise<GitResult<AssistantRewindPreviewResult>> => ({
        ok: true,
        value: preview(),
      })
    ),
    ...overrides,
  };
  (window as unknown as { changes?: ChangesBridge }).changes = {
    fileDiff: vi.fn(async () => ({ error: 'not used', ok: false }) as never),
    finalizeRewinds: vi.fn(async () => ({ error: 'not used', ok: false }) as never),
    inventory: vi.fn(async () => ({ ok: true, value: { errors: [], repositories: [] } }) as never),
    resolveView: vi.fn(async () => ({ error: 'not used', ok: false }) as never),
    ...stub,
  } as unknown as ChangesBridge;
  return stub;
}

function openRewind(composerText: string | null = 'my original prompt'): void {
  useRewindStore.getState().openRewind({
    composerText,
    target: { messageId: 'msg-2', threadId: 'thread-1' },
  });
}

// `ChangedFilesTree` renders through the shared context-action system, so the
// modal must live inside an `ActionRegistryProvider` — as it does in
// `root-layout-content.tsx`.
const testActionRegistry = createTestActionRegistry().registry;

function renderDialog() {
  return render(
    <ActionRegistryProvider registry={testActionRegistry}>
      <RewindConfirmDialog />
      <Toaster />
    </ActionRegistryProvider>
  );
}

beforeEach(() => {
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
  Reflect.deleteProperty(window as unknown as { changes?: unknown }, 'changes');
  vi.restoreAllMocks();
});

describe('RewindConfirmDialog', () => {
  it('renders nothing until an entry point raises a request', () => {
    installBridge();
    renderDialog();

    expect(screen.queryByTestId('rewind-confirm-dialog')).not.toBeInTheDocument();
  });

  it('shows every root of the previewed range, including the out-of-repo file', async () => {
    installBridge();
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
    installBridge();
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    expect(screen.getByTestId('rewind-mode-conversation-and-files')).toBeChecked();
    expect(screen.getByTestId('rewind-mode-conversation-only')).not.toBeChecked();
  });

  it('applies the SELECTED mode, and conversation-only performs no file revert', async () => {
    const user = userEvent.setup();
    const bridge = installBridge();
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    await user.click(screen.getByTestId('rewind-mode-conversation-only'));
    await waitFor(() => {
      expect(screen.getByTestId('rewind-confirm')).toBeEnabled();
    });
    await user.click(screen.getByTestId('rewind-confirm'));

    await waitFor(() => {
      expect(bridge.applyRewind).toHaveBeenCalledWith({
        acknowledgeConflicts: false,
        messageId: 'msg-2',
        mode: 'conversation-only',
        threadId: 'thread-1',
      });
    });
  });

  it('hides the open-files warning in conversation-only mode', async () => {
    const user = userEvent.setup();
    installBridge();
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    expect(screen.getByTestId('rewind-open-files-notice')).toHaveTextContent(
      'Open files will be updated on disk; unsaved external edits may conflict'
    );

    await user.click(screen.getByTestId('rewind-mode-conversation-only'));

    expect(screen.queryByTestId('rewind-open-files-notice')).not.toBeInTheDocument();
  });

  // ===== The acknowledgment gate =====

  it('BLOCKS Restore until every conflicting path is acknowledged', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({
      rewindPreview: vi.fn(async () => ({
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
      expect(bridge.applyRewind).toHaveBeenCalledWith(
        expect.objectContaining({ acknowledgeConflicts: true })
      );
    });
  });

  it('names every conflicting file, DEDUPED across the runs that touched it', async () => {
    installBridge({
      rewindPreview: vi.fn(async () => ({
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
    const bridge = installBridge({
      rewindPreview: vi.fn(async () => ({
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
      expect(bridge.applyRewind).toHaveBeenCalledWith(
        expect.objectContaining({ acknowledgeConflicts: false, mode: 'conversation-only' })
      );
    });
  });

  it('re-gates on a LATE refusal and clears the stale acknowledgment', async () => {
    const user = userEvent.setup();
    const lateConflicts = [conflict(ROOT_B, 'src/index.ts', 'Repo B')];
    const bridge = installBridge({
      applyRewind: vi.fn(async () => ({
        ok: true,
        value: {
          conflicts: lateConflicts,
          message: '1 file(s) cannot be restored cleanly and nothing was applied',
          ok: false,
          reason: 'conflicts-unacknowledged',
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
    expect(bridge.applyRewind).toHaveBeenCalledTimes(1);
  });

  // ===== Post-apply =====

  it('reports EVERY root after applying, including a disconnected one', async () => {
    const user = userEvent.setup();
    installBridge({
      applyRewind: vi.fn(async () => ({
        ok: true,
        value: {
          ...APPLIED,
          fileOutcomes: [
            ...APPLIED.fileOutcomes.slice(0, 2),
            {
              checkpointId: 'cp-c',
              code: 'conflict' as const,
              message: 'workspace root is no longer connected',
              path: 'notes/scratch.md',
              rootId: ROOT_PLAIN,
            },
          ],
          rootOutcomes: [
            ...APPLIED.rootOutcomes.slice(0, 2),
            {
              attempted: 1,
              conflicts: 1,
              failed: 1,
              reverted: 0,
              rootId: ROOT_PLAIN,
              rootLabel: 'Scratch',
              rootPath: null,
            },
          ],
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

  it('offers a redo affordance in a toast, and wires it to redoRewind', async () => {
    const user = userEvent.setup();
    const bridge = installBridge();
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
      expect(bridge.redoRewind).toHaveBeenCalledWith({ rewindId: 'rewind-1' });
    });
  });

  // ===== Composer repopulation (Amendment 2) =====

  it('repopulates the composer with the TARGET USER MESSAGE text', async () => {
    const user = userEvent.setup();
    installBridge();
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

  it('does NOT repopulate when the target carries no prompt', async () => {
    const user = userEvent.setup();
    installBridge();
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
    installBridge({
      rewindPreview: vi.fn(async () => ({
        ok: true,
        value: {
          conflicts: [],
          message: 'message "msg-2" was not found in thread "thread-1".',
          ok: false,
          reason: 'message-not-found',
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
    installBridge({
      rewindPreview: vi.fn(async () => ({ error: 'bridge exploded', ok: false })),
    });
    openRewind();
    renderDialog();

    expect(await screen.findByTestId('rewind-preview-error')).toHaveTextContent('bridge exploded');
    expect(screen.queryByTestId('rewind-preview-refused')).not.toBeInTheDocument();
  });

  it('closes without applying anything on Cancel', async () => {
    const user = userEvent.setup();
    const bridge = installBridge();
    openRewind();
    renderDialog();

    await screen.findByTestId('rewind-confirm-dialog');
    await user.click(screen.getByTestId('rewind-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('rewind-confirm-dialog')).not.toBeInTheDocument();
    });
    expect(bridge.applyRewind).not.toHaveBeenCalled();
    expect(useRewindStore.getState().request).toBeNull();
  });
});
