/**
 * The Conversation Rewind confirm modal's port (BST-1977, gap 2): what the
 * ONE modal needs from a rewind owner, so a legacy thread (Main's
 * `window.changes` rewind service) and a host thread (the agent host's
 * `thread/rewind*` methods) share it without either inventing the other's
 * facts. Each adapter maps its own owner's answers; no field here stands in
 * for something an owner does not have.
 *
 * The two owners differ in what a rewind does to the conversation, and the
 * modal says so: a legacy rewind HIDES messages (tombstones, finalized by the
 * next message); a host rewind moves the thread back, so the later turns stay
 * on their own branch, reachable with the branch picker.
 */
import type {
  AssistantRewindConflict,
  AssistantRewindFileOutcome,
  AssistantRewindMode,
  AssistantRewindRootOutcome,
} from '@brainstrike/assistant-contract';
import type { Changeset, ChangesetView, GitResult, StructuredFileDiff } from '@brainstrike/types';
import type { ChangesBridge, RewindPreviewPayload } from './changes-bridge';

/** What a rewind does to the conversation after the target message. */
export type RewindConversationEffect =
  /** Legacy: these messages are hidden until the next message finalizes them. */
  | { readonly kind: 'hidden'; readonly messages: number }
  /** Host: these turns leave the conversation and stay on their own branch. */
  | { readonly kind: 'branched'; readonly turns: number };

/** Whether the files scope can be offered; when not, the owner's reason. */
export type RewindFilesScopeModel =
  | { readonly available: true }
  | { readonly available: false; readonly message: string };

/** One file the files scope cannot restore cleanly, named by path. */
export interface RewindConflictModel {
  /** Whether acknowledging overwrites it; false when it is left as it is. */
  readonly forceable: boolean;
  readonly message: string;
  readonly path: string;
  readonly rootId: string;
  readonly rootLabel: string | null;
}

export type RewindPreviewModel =
  | {
      readonly changeset: Changeset | null;
      readonly conflicts: readonly RewindConflictModel[];
      readonly conversation: RewindConversationEffect;
      readonly filesScope: RewindFilesScopeModel;
      readonly messageId: string;
      /** No agent file edits are recorded after the message (legacy only). */
      readonly noRecordedEdits: boolean;
      readonly ok: true;
      /** The owner's preview identity the apply binds to; null when the owner keys it itself. */
      readonly previewId: string | null;
      /**
       * The roots the files scope restores, or null when this owner reports
       * them only with the apply's outcome (legacy).
       */
      readonly restoreRoots: readonly RewindRootRef[] | null;
      readonly threadId: string;
      readonly view: ChangesetView | null;
    }
  | { readonly message: string; readonly ok: false };

export type ReadyRewindPreview = Extract<RewindPreviewModel, { ok: true }>;

export interface RewindRootRef {
  readonly rootId: string;
  /** Null when the root is not connected. */
  readonly rootPath: string | null;
}

/** A root's roll-up; every root the restore covered appears, including a zero. */
export interface RewindRootOutcomeModel extends RewindRootRef {
  readonly attempted: number;
  readonly conflicts: number;
  readonly failed: number;
  readonly label: string | null;
  readonly restored: number;
}

export interface RewindOutcomeModel {
  readonly conversation: RewindConversationEffect;
  /** Each file that was not restored, named. */
  readonly notRestored: readonly {
    readonly message: string;
    readonly path: string;
    readonly rootId: string;
  }[];
  readonly roots: readonly RewindRootOutcomeModel[];
}

/** What undoing a rewind needs: its id, and the roots it restored. */
export interface RewindUndo {
  readonly rewindId: string;
  readonly roots: readonly RewindRootRef[];
}

export type RewindApplyResult =
  | { readonly ok: true; readonly outcome: RewindOutcomeModel; readonly rewindId: string }
  | {
      /** Non-null: nothing was applied until these are acknowledged. */
      readonly conflicts: readonly RewindConflictModel[] | null;
      readonly message: string;
      readonly ok: false;
      /**
       * Non-null when the rewind took effect but stopped partway (the owner
       * committed it as interrupted): it can still be undone.
       */
      readonly redoable: RewindUndo | null;
    };

export type RewindRedoResult =
  | { readonly description: string; readonly ok: true; readonly roots: readonly RewindRootRef[] }
  /** `forceable`: the same paths can be overwritten by redoing with acknowledgment. */
  | { readonly forceable: boolean; readonly message: string; readonly ok: false };

export interface RewindPort {
  apply(args: {
    readonly acknowledgeConflicts: boolean;
    readonly mode: AssistantRewindMode;
    readonly preview: ReadyRewindPreview;
  }): Promise<GitResult<RewindApplyResult>>;
  /** What this owner's rewinds do to the later messages. */
  readonly conversation: RewindConversationEffect['kind'];
  /** A file's diff in the previewed changeset; `rootId` comes from the file entry. */
  fileDiff(
    changeset: Changeset,
    path: string,
    rootId: string
  ): Promise<GitResult<StructuredFileDiff>>;
  preview(target: RewindPreviewPayload): Promise<GitResult<RewindPreviewModel>>;
  redo(args: {
    readonly acknowledgeConflicts: boolean;
    readonly rewindId: string;
    /** The roots the rewind restored, as its apply reported them. */
    readonly roots: readonly RewindRootRef[];
    readonly threadId: string;
  }): Promise<GitResult<RewindRedoResult>>;
}

/** Only these legacy codes are overwritten by acknowledgment; the rest are left as they are. */
const FORCEABLE_LEGACY_CODES: ReadonlySet<AssistantRewindConflict['code']> = new Set([
  'disk-changed',
  'path-occupied',
]);

function legacyConflict(conflict: AssistantRewindConflict): RewindConflictModel {
  return {
    forceable: FORCEABLE_LEGACY_CODES.has(conflict.code),
    message: conflict.message,
    path: conflict.path,
    rootId: conflict.rootId,
    rootLabel: conflict.rootLabel,
  };
}

function legacyOutcome(
  fileOutcomes: readonly AssistantRewindFileOutcome[],
  rootOutcomes: readonly AssistantRewindRootOutcome[],
  hiddenMessages: number
): RewindOutcomeModel {
  return {
    conversation: { kind: 'hidden', messages: hiddenMessages },
    notRestored: fileOutcomes
      .filter((outcome) => outcome.code !== 'reverted')
      .map(({ code, message, path, rootId }) => ({ message: message ?? code, path, rootId })),
    roots: rootOutcomes.map((root) => ({
      attempted: root.attempted,
      conflicts: root.conflicts,
      failed: root.failed,
      label: root.rootLabel,
      restored: root.reverted,
      rootId: root.rootId,
      rootPath: root.rootPath,
    })),
  };
}

/** A legacy thread's rewinds, through Main's rewind service on `window.changes`. */
export function createLegacyRewindPort(bridge: ChangesBridge): RewindPort {
  return {
    apply: async ({ acknowledgeConflicts, mode, preview }) => {
      const result = await bridge.applyRewind({
        acknowledgeConflicts,
        messageId: preview.messageId,
        mode,
        threadId: preview.threadId,
      });
      if (!result.ok) {
        return result;
      }
      const applied = result.value;
      if (!applied.ok) {
        return {
          ok: true,
          value: {
            conflicts:
              applied.reason === 'conflicts-unacknowledged'
                ? applied.conflicts.map(legacyConflict)
                : null,
            message: applied.message,
            ok: false,
            redoable: null,
          },
        };
      }
      return {
        ok: true,
        value: {
          ok: true,
          outcome: legacyOutcome(
            applied.fileOutcomes,
            applied.rootOutcomes,
            applied.tombstonedMessageIds.length
          ),
          rewindId: applied.rewindId,
        },
      };
    },
    conversation: 'hidden',
    fileDiff: (changeset, path, rootId) => bridge.fileDiff(rootId, changeset, path),
    preview: async (target) => {
      const result = await bridge.rewindPreview(target);
      if (!result.ok) {
        return result;
      }
      const preview = result.value;
      if (!preview.ok) {
        return { ok: true, value: { message: preview.message, ok: false } };
      }
      return {
        ok: true,
        value: {
          changeset: preview.changeset,
          conflicts: preview.conflicts.map(legacyConflict),
          conversation: { kind: 'hidden', messages: preview.tombstoneMessageIds.length },
          filesScope:
            preview.filesScope.available === true
              ? { available: true }
              : { available: false, message: preview.filesScope.message },
          messageId: preview.messageId,
          noRecordedEdits: preview.range.kind === 'none',
          ok: true,
          // Main fingerprints the preview by its target; the apply needs no identity.
          previewId: null,
          restoreRoots: null,
          threadId: preview.threadId,
          view: preview.view,
        },
      };
    },
    redo: async ({ acknowledgeConflicts, rewindId }) => {
      const result = await bridge.redoRewind({ acknowledgeConflicts, rewindId });
      if (!result.ok) {
        return result;
      }
      const redone = result.value;
      if (!redone.ok) {
        return {
          ok: true,
          value: {
            forceable: redone.reason === 'conflicts-unacknowledged',
            message: redone.message,
            ok: false,
          },
        };
      }
      return {
        ok: true,
        value: {
          description: `${redone.restoredMessageIds.length} message(s) are back.`,
          ok: true,
          roots: redone.rootOutcomes.map(({ rootId, rootPath }) => ({ rootId, rootPath })),
        },
      };
    },
  };
}
