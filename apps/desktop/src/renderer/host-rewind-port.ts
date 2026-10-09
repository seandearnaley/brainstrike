/**
 * A host thread's rewinds for the ONE confirm modal (BST-1977, gap 2): the
 * agent host's `thread/rewind*` methods behind the modal's `RewindPort`.
 *
 * A host rewind moves the thread back to before the message; the later turns
 * stay on their own branch. In files mode the host restores each root to its
 * restore point. The preview's tree and diffs are Main's resolution of the
 * same restore: a host `run-range` from the preview's `fromRunId`, against
 * the live work-tree.
 */
import type { HostClient } from '@brainstrike/agent-host/browser';
import type {
  HostResults,
  HostRewindConflict,
  HostRewindFileOutcome,
} from '@brainstrike/agent-host/protocol';
import type {
  ChangesBridge,
  ReadyRewindPreview,
  RewindConflictModel,
  RewindOutcomeModel,
  RewindPort,
  RewindRootRef,
} from '@brainstrike/app-shell/changes';
import type { AssistantRewindMode } from '@brainstrike/assistant-contract';
import type { Changeset } from '@brainstrike/types';

type HostRequest = Pick<HostClient, 'request'>;

function conflicts(
  found: readonly HostRewindConflict[],
  message: string
): readonly RewindConflictModel[] {
  return found.map(({ path, rootId }) => ({
    // The host overwrites an acknowledged path with its restore point.
    forceable: true,
    message,
    path,
    rootId,
    rootLabel: null,
  }));
}

function pathList(found: readonly HostRewindConflict[]): string {
  return found.map(({ path }) => path).join(', ');
}

const NOT_RESTORED: Readonly<Record<HostRewindFileOutcome['status'], string | null>> = {
  conflict: null,
  deleted: null,
  failed: null,
  restored: null,
  'skipped-nested-repo': 'inside a nested repository; left as it is',
};

/** Each covered root's roll-up, and every file that was not restored, named. */
function outcomeOf(
  outcomes: readonly HostRewindFileOutcome[],
  roots: readonly RewindRootRef[],
  turns: number
): RewindOutcomeModel {
  return {
    conversation: { kind: 'branched', turns },
    notRestored: outcomes.flatMap((outcome) => {
      if (outcome.status === 'conflict' || outcome.status === 'failed') {
        return [{ message: outcome.detail, path: outcome.path, rootId: outcome.rootId }];
      }
      const skipped = NOT_RESTORED[outcome.status];
      return skipped ? [{ message: skipped, path: outcome.path, rootId: outcome.rootId }] : [];
    }),
    roots: roots.map((root) => {
      const own = outcomes.filter((outcome) => outcome.rootId === root.rootId);
      const count = (...statuses: HostRewindFileOutcome['status'][]) =>
        own.filter((outcome) => statuses.includes(outcome.status)).length;
      return {
        ...root,
        attempted: own.length,
        conflicts: count('conflict'),
        failed: count('failed', 'skipped-nested-repo'),
        label: null,
        restored: count('restored', 'deleted'),
      };
    }),
  };
}

type Preview = HostResults['thread/rewind/preview'];

/** The roots a files rewind restores: its preview's; a conversation rewind restores none. */
function restoredRoots(
  preview: ReadyRewindPreview,
  mode: AssistantRewindMode
): readonly RewindRootRef[] {
  if (mode === 'conversation-only') {
    return [];
  }
  if (!preview.restoreRoots) {
    throw new Error('A files rewind needs the roots its preview restores');
  }
  return preview.restoreRoots;
}

function branchedTurns(preview: ReadyRewindPreview): number {
  if (preview.conversation.kind !== 'branched') {
    throw new Error('A host rewind preview branches the conversation');
  }
  return preview.conversation.turns;
}

/** The modal's preview: the host's restore plan, and Main's view of it. */
async function previewModel(
  changes: Pick<ChangesBridge, 'resolveView'>,
  threadId: string,
  messageId: string,
  preview: Preview
) {
  const base = {
    conflicts: [],
    conversation: { kind: 'branched', turns: preview.runIds.length } as const,
    messageId,
    noRecordedEdits: false,
    ok: true as const,
    threadId,
  };
  const { files } = preview;
  if (!files.available) {
    return {
      ...base,
      changeset: null,
      filesScope: { available: false as const, message: files.reason },
      previewId: null,
      restoreRoots: null,
      view: null,
    };
  }
  const changeset: Changeset = { fromRunId: files.fromRunId, kind: 'run-range', threadId };
  const restoreRoots = files.roots.map(({ rootId, rootPath }) => ({ rootId, rootPath }));
  const [first] = files.roots;
  if (!first) {
    // No root has a restore point, so the files scope restores nothing.
    return {
      ...base,
      changeset,
      filesScope: { available: true as const },
      previewId: files.previewId,
      restoreRoots,
      view: { changeset, files: [], totalAdditions: 0, totalDeletions: 0 },
    };
  }
  // A run range resolves across all its roots; the root argument picks none.
  const view = await changes.resolveView(first.rootId, changeset);
  if (!view.ok) {
    // Without its diff, the files scope cannot be shown, so it is not offered.
    return {
      ...base,
      changeset: null,
      filesScope: {
        available: false as const,
        message: `The files this would restore could not be listed: ${view.error}`,
      },
      previewId: null,
      restoreRoots: null,
      view: null,
    };
  }
  return {
    ...base,
    changeset,
    filesScope: { available: true as const },
    previewId: files.previewId,
    restoreRoots,
    view: view.value,
  };
}

export function createHostRewindPort(
  client: HostRequest,
  changes: Pick<ChangesBridge, 'fileDiff' | 'resolveView'>
): RewindPort {
  return {
    apply: async ({ acknowledgeConflicts, mode, preview }) => {
      const result = await client.request('thread/rewind', {
        ...(acknowledgeConflicts ? { acknowledgeConflicts: true } : {}),
        commandId: crypto.randomUUID(),
        messageId: preview.messageId,
        mode,
        ...(preview.previewId === null ? {} : { previewId: preview.previewId }),
        threadId: preview.threadId,
      });
      const roots = restoredRoots(preview, mode);
      const turns = branchedTurns(preview);
      if (result.status === 'conflicts') {
        return {
          ok: true,
          value: {
            conflicts: conflicts(result.conflicts, 'changed after the preview'),
            message: `${result.conflicts.length} file(s) changed after the preview and nothing was applied: ${pathList(result.conflicts)}.`,
            ok: false,
            redoable: null,
          },
        };
      }
      if (result.status === 'interrupted') {
        return {
          ok: true,
          value: {
            conflicts: null,
            message: `The conversation moved back, but restoring its files stopped partway: ${result.detail}. Files may be partly restored.`,
            ok: false,
            redoable: { rewindId: result.rewindId, roots },
          },
        };
      }
      return {
        ok: true,
        value: {
          ok: true,
          outcome: outcomeOf(result.outcomes, roots, turns),
          rewindId: result.rewindId,
        },
      };
    },
    conversation: 'branched',
    fileDiff: (changeset, path, rootId) => changes.fileDiff(rootId, changeset, path),
    preview: async (target) => {
      if (target.messageId === undefined) {
        return {
          error: 'A host thread restores to before a message: use the message’s Restore action.',
          ok: false,
        };
      }
      const preview = await client.request('thread/rewind/preview', {
        messageId: target.messageId,
        threadId: target.threadId,
      });
      return {
        ok: true,
        value: await previewModel(changes, target.threadId, target.messageId, preview),
      };
    },
    redo: async ({ acknowledgeConflicts, rewindId, roots, threadId }) => {
      const result = await client.request('thread/rewind/redo', {
        ...(acknowledgeConflicts ? { acknowledgeConflicts: true } : {}),
        commandId: crypto.randomUUID(),
        rewindId,
        threadId,
      });
      if (result.status === 'conflicts') {
        return {
          ok: true,
          value: {
            forceable: true,
            message: `${result.conflicts.length} file(s) changed since the rewind restored them: ${pathList(result.conflicts)}. Undo anyway overwrites them.`,
            ok: false,
          },
        };
      }
      if (result.status === 'interrupted') {
        return {
          ok: true,
          value: {
            forceable: false,
            message: `Undoing the rewind stopped partway: ${result.detail}. Files may be partly restored.`,
            ok: false,
          },
        };
      }
      return {
        ok: true,
        value: {
          description:
            result.outcomes.length > 0
              ? 'The conversation and its files are back where they were.'
              : 'The conversation is back where it was.',
          ok: true,
          roots,
        },
      };
    },
  };
}
