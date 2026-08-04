/**
 * `ChangesetDiffPane` (BST-1114, W4 Task C): the multi-file diff stack for
 * the Changes surface — the first consumer of `DiffView`'s
 * `{ kind: 'structured', diff }` source (`packages/ui/src/diff-view`); the
 * two prior call sites (`git-diff-surface.tsx`,
 * `assistant-tool-approval-notice.tsx`) both use the legacy `strings` mode.
 *
 * Reads `selectedFileKeys` from `changes-store.ts` itself (not modified by
 * this task) and applies `selectRenderedFiles` — an EMPTY selection renders
 * EVERY file in the changeset, never zero; see that helper's doc comment
 * (SELECTION SEMANTICS) for the settled rationale. A changeset that
 * genuinely has no files is a DIFFERENT fact from nothing being selected,
 * and this pane distinguishes the two rather than collapsing them into one
 * blank state.
 *
 * One shared scroll container hosts the whole vertical stack; each
 * `ChangesetFileDiffCard` renders its own sticky `top-0` header inside it,
 * so the active file stays legible while its body scrolls past underneath
 * (the same `sticky top-0 z-10` pattern already used for local group
 * headers in `git-changes-view.tsx` and `model-picker-group.tsx` — not a
 * Radix-portaled floating layer, so it does not draw from
 * `packages/ui/src/layers.ts`'s dialog stacking scale).
 *
 * Per-file loading is entirely owned by `ChangesetFileDiffCard` (lazy,
 * generation-guarded, IntersectionObserver-gated) — this pane never fetches
 * eagerly and never lets one file's failure blank the others, since each
 * card carries its own independent load state.
 */
import type {
  ChangedFileEntry,
  Changeset,
  GitResult,
  StructuredFileDiff,
} from '@brainstrike/types';
import { type ReactElement, useMemo } from 'react';
import { changedFileKey, selectRenderedFiles, useChangesStore } from '../changes-store';
import { ChangesetFileDiffCard } from './changeset-file-diff-card';

export interface ChangesetDiffPaneProps {
  /**
   * Structural identity of the active changeset. Part of each card's React
   * key: `changedFileKey` carries no changeset identity, so a file present in
   * both the old and the new changeset would otherwise REUSE its card
   * instance — and that card has already latched `hasStarted`, so it would
   * keep displaying the diff it loaded for the previous changeset while the
   * header describes the new one.
   */
  readonly changesetKey: string;
  readonly changesetKind: Changeset['kind'];
  readonly files: readonly ChangedFileEntry[];
  readonly loadFileDiff: (path: string) => Promise<GitResult<StructuredFileDiff>>;
}

function EmptyPaneState({
  message,
  testId,
}: {
  readonly message: string;
  readonly testId: string;
}): ReactElement {
  return (
    <div
      className="grid h-full min-h-0 place-items-center px-8 text-center text-muted-foreground text-sm"
      data-testid={testId}
    >
      <div className="max-w-sm leading-relaxed">{message}</div>
    </div>
  );
}

export function ChangesetDiffPane({
  changesetKey,
  changesetKind,
  files,
  loadFileDiff,
}: ChangesetDiffPaneProps): ReactElement {
  const selectedFileKeys = useChangesStore((selectorState) => selectorState.selectedFileKeys);
  const renderedFiles = useMemo(
    () => selectRenderedFiles(files, selectedFileKeys),
    [files, selectedFileKeys]
  );

  if (files.length === 0) {
    return (
      <EmptyPaneState
        message="This changeset has no files."
        testId="changeset-diff-pane-empty-changeset"
      />
    );
  }

  if (renderedFiles.length === 0) {
    return (
      <EmptyPaneState
        message="No files match the current selection — check files in the tree to see their diffs."
        testId="changeset-diff-pane-empty-selection"
      />
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto" data-testid="changeset-diff-pane">
      <div className="flex flex-col divide-y divide-border">
        {renderedFiles.map((entry) => (
          <ChangesetFileDiffCard
            changesetKind={changesetKind}
            entry={entry}
            key={`${changesetKey}|${changedFileKey(entry)}`}
            loadFileDiff={loadFileDiff}
          />
        ))}
      </div>
    </div>
  );
}
