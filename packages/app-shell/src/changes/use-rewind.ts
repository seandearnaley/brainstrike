/**
 * `useRewind` (BST-1115, W5 T4): load a Conversation Rewind preview and bind
 * the apply/redo actions to the desktop `window.changes` bridge.
 *
 * Generation-guarded exactly like `use-changeset.ts`/`use-edit-checkpoints.ts`:
 * the counter increments BEFORE the await, is captured, and every `setState`
 * — success AND error branches — is skipped when a newer load has started. A
 * rewind preview is slow enough (it scans the whole revert plan against disk)
 * that a second target opened while the first is in flight is a realistic way
 * to paint one rewind's file list under another rewind's confirm button.
 *
 * `apply` and `redo` are NOT hook state. They are one-shot destructive calls
 * whose result the caller must handle in full — including the
 * `conflicts-unacknowledged` refusal, which is a real answer and not an error.
 * Storing their result here would invite a component to read a stale success.
 */
import type {
  AssistantRewindMode,
  AssistantRewindPreviewResult,
  AssistantRewindRedoResult,
  AssistantRewindResult,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { GitResult, StructuredFileDiff } from '@brainstrike/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type RewindPreviewPayload, resolveChangesBridge } from './changes-bridge';
import { useStructuralIdentity } from './use-structural-identity';

const logger = createLogger('UseRewind');

export interface UseRewindResult {
  /**
   * Apply the rewind. `acknowledgeConflicts` must be `true` before a conflicted
   * files-mode rewind writes anything — the gate itself lives in the main
   * process, this only carries the flag the user actually ticked.
   */
  readonly apply: (args: {
    readonly acknowledgeConflicts: boolean;
    readonly messageId: string;
    readonly mode: AssistantRewindMode;
    readonly threadId: string;
  }) => Promise<GitResult<AssistantRewindResult>>;
  /** True when the desktop `window.changes` bridge is present and well-formed. */
  readonly available: boolean;
  /** Transport/bridge failure. Domain refusals live inside `preview`, not here. */
  readonly error: string | null;
  /**
   * Lazy per-file diff for the previewed run-range changeset. `entryRootId`
   * comes from the file entry itself: a journal changeset identifies a file by
   * `(rootId, path)`, and a multi-root turn has more than one root in one
   * changeset. An entry without a rootId returns a typed failure rather than
   * guessing a root — see the MULTI-ROOT BAR.
   */
  readonly fileDiff: (
    path: string,
    entryRootId: string | null
  ) => Promise<GitResult<StructuredFileDiff>>;
  /** True while the preview is in flight. */
  readonly loading: boolean;
  /** The resolved preview, or `null` before one has landed. */
  readonly preview: AssistantRewindPreviewResult | null;
  /** Undo the newest rewind in the thread. One level, until finalization. */
  readonly redo: (args: {
    readonly acknowledgeConflicts?: boolean;
    readonly rewindId: string;
  }) => Promise<GitResult<AssistantRewindRedoResult>>;
}

const BRIDGE_ABSENT: GitResult<never> = {
  error:
    'Conversation Rewind is unavailable: the desktop changes bridge is not present. This is a desktop-only capability.',
  ok: false,
};

export function useRewind(target: RewindPreviewPayload | null): UseRewindResult {
  // Resolved ONCE per hook instance — `isChangesBridgeAvailable()` re-resolves
  // (and re-LOGS on a malformed bridge) every call; `use-changeset.ts` avoids
  // that the same way.
  const bridge = useMemo(() => resolveChangesBridge(), []);
  const [preview, setPreview] = useState<AssistantRewindPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generationRef = useRef(0);

  // Structural identity, same reason as `use-changeset.ts`'s `stableChangeset`:
  // callers build `{ threadId, messageId }` inline, and a successful load's own
  // `setPreview` re-renders, so a reference-compared dependency never settles.
  const stableTarget = useStructuralIdentity(target);

  const load = useCallback(async (): Promise<void> => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const isCurrent = (): boolean => generation === generationRef.current;
    if (!(bridge && stableTarget)) {
      if (isCurrent()) {
        setPreview(null);
        setError(null);
        setLoading(false);
      }
      return;
    }
    if (isCurrent()) {
      setLoading(true);
      setError(null);
    }
    try {
      const result = await bridge.rewindPreview(stableTarget);
      if (!isCurrent()) {
        return;
      }
      if (result.ok) {
        setPreview(result.value);
        setError(null);
      } else {
        setPreview(null);
        setError(result.error);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      logger.error('Failed to load rewind preview', { error: caught });
      if (isCurrent()) {
        setPreview(null);
        setError(message);
      }
    } finally {
      if (isCurrent()) {
        setLoading(false);
      }
    }
  }, [bridge, stableTarget]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeset = preview?.ok === true ? preview.changeset : null;

  const fileDiff = useCallback(
    async (path: string, entryRootId: string | null): Promise<GitResult<StructuredFileDiff>> => {
      if (!bridge) {
        return BRIDGE_ABSENT;
      }
      if (!changeset) {
        return { error: 'rewind-preview-unavailable: no resolved changeset', ok: false };
      }
      if (entryRootId === null) {
        return {
          error: `Cannot load a diff for "${path}": the journal entry carries no workspace root.`,
          ok: false,
        };
      }
      try {
        return await bridge.fileDiff(entryRootId, changeset, path);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        logger.error('Failed to load rewind file diff', { error: caught, path });
        return { error: message, ok: false };
      }
    },
    [bridge, changeset]
  );

  const apply = useCallback<UseRewindResult['apply']>(
    async (args) => {
      if (!bridge) {
        return BRIDGE_ABSENT;
      }
      try {
        return await bridge.applyRewind(args);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        logger.error('Failed to apply rewind', { error: caught });
        return { error: message, ok: false };
      }
    },
    [bridge]
  );

  const redo = useCallback<UseRewindResult['redo']>(
    async (args) => {
      if (!bridge) {
        return BRIDGE_ABSENT;
      }
      try {
        return await bridge.redoRewind(args);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        logger.error('Failed to redo rewind', { error: caught });
        return { error: message, ok: false };
      }
    },
    [bridge]
  );

  return { apply, available: bridge !== null, error, fileDiff, loading, preview, redo };
}
