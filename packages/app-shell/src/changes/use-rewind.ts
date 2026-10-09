/**
 * `useRewind` (BST-1115, W5 T4): load a Conversation Rewind preview through
 * the request's rewind port (`rewind-port.ts`) and bind its apply/redo.
 *
 * Generation-guarded exactly like `use-changeset.ts`/`use-edit-checkpoints.ts`:
 * the counter increments BEFORE the await, is captured, and every `setState`
 * — success AND error branches — is skipped when a newer load has started. A
 * rewind preview is slow enough (it scans the whole revert plan against disk)
 * that a second target opened while the first is in flight is a realistic way
 * to paint one rewind's file list under another rewind's confirm button.
 *
 * `apply` and `redo` are NOT hook state. They are one-shot destructive calls
 * whose result the caller must handle in full — including a conflict refusal,
 * which is a real answer and not an error. Storing their result here would
 * invite a component to read a stale success.
 */
import { createLogger } from '@brainstrike/logging';
import type { GitResult, StructuredFileDiff } from '@brainstrike/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RewindPreviewPayload } from './changes-bridge';
import type {
  RewindApplyResult,
  RewindPort,
  RewindPreviewModel,
  RewindRedoResult,
} from './rewind-port';

const logger = createLogger('UseRewind');

export interface UseRewindResult {
  /**
   * Apply the rewind. `acknowledgeConflicts` must be `true` before a conflicted
   * files-mode rewind writes anything — the gate itself lives in the owner,
   * this only carries the flag the user actually ticked.
   */
  readonly apply: (
    args: Parameters<RewindPort['apply']>[0]
  ) => Promise<GitResult<RewindApplyResult>>;
  /** Transport failure. Owner refusals live inside `preview`, not here. */
  readonly error: string | null;
  /**
   * Lazy per-file diff for the previewed changeset. `entryRootId` comes from
   * the file entry itself: a changeset identifies a file by `(rootId, path)`,
   * and a multi-root turn has more than one root in one changeset. An entry
   * without a rootId returns a typed failure rather than guessing a root.
   */
  readonly fileDiff: (
    path: string,
    entryRootId: string | null
  ) => Promise<GitResult<StructuredFileDiff>>;
  /** True while the preview is in flight. */
  readonly loading: boolean;
  /** The resolved preview, or `null` before one has landed. */
  readonly preview: RewindPreviewModel | null;
  /** Undo the newest rewind in the thread. One level, until the next message. */
  readonly redo: (args: Parameters<RewindPort['redo']>[0]) => Promise<GitResult<RewindRedoResult>>;
}

function failure(caught: unknown): { readonly error: string; readonly ok: false } {
  return { error: caught instanceof Error ? caught.message : String(caught), ok: false };
}

export function useRewind(port: RewindPort, target: RewindPreviewPayload): UseRewindResult {
  const [preview, setPreview] = useState<RewindPreviewModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generationRef = useRef(0);

  // Structural identity, same reason as `use-changeset.ts`'s `stableChangeset`:
  // callers build `{ threadId, messageId }` inline, and a successful load's own
  // `setPreview` re-renders, so a reference-compared dependency never settles.
  const targetKey = JSON.stringify(target);
  const stableTarget = useMemo(() => target, [targetKey]);

  const load = useCallback(async (): Promise<void> => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const isCurrent = (): boolean => generation === generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await port.preview(stableTarget);
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
      logger.error('Failed to load rewind preview', { error: caught });
      if (isCurrent()) {
        setPreview(null);
        setError(failure(caught).error);
      }
    } finally {
      if (isCurrent()) {
        setLoading(false);
      }
    }
  }, [port, stableTarget]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeset = preview?.ok === true ? preview.changeset : null;

  const fileDiff = useCallback(
    async (path: string, entryRootId: string | null): Promise<GitResult<StructuredFileDiff>> => {
      if (!changeset) {
        return { error: 'rewind-preview-unavailable: no resolved changeset', ok: false };
      }
      if (entryRootId === null) {
        return {
          error: `Cannot load a diff for "${path}": the file entry carries no workspace root.`,
          ok: false,
        };
      }
      try {
        return await port.fileDiff(changeset, path, entryRootId);
      } catch (caught) {
        logger.error('Failed to load rewind file diff', { error: caught, path });
        return failure(caught);
      }
    },
    [port, changeset]
  );

  const apply = useCallback<UseRewindResult['apply']>(
    async (args) => {
      try {
        return await port.apply(args);
      } catch (caught) {
        logger.error('Failed to apply rewind', { error: caught });
        return failure(caught);
      }
    },
    [port]
  );

  const redo = useCallback<UseRewindResult['redo']>(
    async (args) => {
      try {
        return await port.redo(args);
      } catch (caught) {
        logger.error('Failed to redo rewind', { error: caught });
        return failure(caught);
      }
    },
    [port]
  );

  return { apply, error, fileDiff, loading, preview, redo };
}
