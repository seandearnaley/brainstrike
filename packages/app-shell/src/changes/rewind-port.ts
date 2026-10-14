/** The agent host's rewind projection consumed by the shared confirmation modal. */
import type { AssistantRewindMode } from '@brainstrike/assistant-contract';
import type { Changeset, ChangesetView, GitResult, StructuredFileDiff } from '@brainstrike/types';
import type { RewindPreviewPayload } from './changes-bridge';

/** What a rewind does to the conversation after the target message. */
export interface RewindConversationEffect {
  readonly kind: 'branched';
  readonly turns: number;
}

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
      /** No agent file edits are recorded after the message. */
      readonly noRecordedEdits: boolean;
      readonly ok: true;
      /** The owner's preview identity the apply binds to; null when the owner keys it itself. */
      readonly previewId: string | null;
      /**
       * The roots the files scope restores, or null when this owner reports
       * them only with the apply's outcome.
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
