/**
 * `ChangesetDiffPane` (BST-1114, W4 Task C): the multi-file diff stack for
 * the Changes surface — the first consumer of `DiffView`'s
 * `{ kind: 'structured', diff }` source (`packages/ui/src/diff-view`).
 * `assistant-tool-approval-notice.tsx` is the only `strings` call site (it
 * has direct old/new text, never a unified diff to parse).
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
 * headers in `model-picker-group.tsx` — not a
 * Radix-portaled floating layer, so it does not draw from
 * `packages/ui/src/layers.ts`'s dialog stacking scale).
 *
 * Per-file loading is entirely owned by `ChangesetFileDiffCard` (lazy,
 * generation-guarded, IntersectionObserver-gated) — this pane never fetches
 * eagerly and never lets one file's failure blank the others, since each
 * card carries its own independent load state.
 */
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { ChangedFileEntry, Changeset, StructuredFileDiff } from '@brainstrike/types';
import { Button, type DiffViewMode } from '@brainstrike/ui';
import { type ReactElement, useMemo, useState } from 'react';
import { changedFileKey, selectRenderedFiles, useChangesStore } from '../changes-store';
import { ChangesetFileDiffCard, type ChangesetFileDiffCardProps } from './changeset-file-diff-card';

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
  /** Threaded straight through to `ChangesetFileDiffCard` — see its own doc comment on the `rootId` parameter. */
  readonly loadFileDiff: (
    path: string,
    rootId: string | null
  ) => Promise<BoundaryResult<StructuredFileDiff>>;
  /** Threaded straight through to each `ChangesetFileDiffCard` (BST-2334). */
  readonly onLineComment?: ChangesetFileDiffCardProps['onLineComment'];
  /** Threaded straight through to `ChangesetFileDiffCard` — see its `reloadToken` doc comment (BST-1161). */
  readonly reloadToken?: number;
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
      className="text-muted-foreground grid h-full min-h-0 place-items-center px-8 text-center text-sm"
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
  onLineComment,
  reloadToken,
}: ChangesetDiffPaneProps): ReactElement {
  const selectedFileKeys = useChangesStore((selectorState) => selectorState.selectedFileKeys);
  // One view mode for the whole stack, switched from the pane's toolbar,
  // rather than a toolbar row and toggle inside every file's card.
  const [mode, setMode] = useState<DiffViewMode>('split');
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
    <div className="flex h-full min-h-0 flex-col" data-testid="changeset-diff-pane">
      <div className="border-border flex h-8 shrink-0 items-center justify-between gap-2 border-b px-3">
        <span className="text-muted-foreground text-xs" data-testid="changeset-diff-pane-count">
          {renderedFiles.length === files.length
            ? `${files.length} ${files.length === 1 ? 'file' : 'files'}`
            : `${renderedFiles.length} of ${files.length} files`}
        </span>
        <Button
          aria-label={mode === 'split' ? 'Switch to inline diff' : 'Switch to side-by-side diff'}
          aria-pressed={mode === 'unified'}
          data-testid="changeset-diff-pane-mode"
          onClick={() => setMode((current) => (current === 'split' ? 'unified' : 'split'))}
          size="xs"
          type="button"
          variant="outline"
        >
          {mode === 'split' ? 'Inline' : 'Side by side'}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="divide-border flex flex-col divide-y">
          {renderedFiles.map((entry) => (
            <ChangesetFileDiffCard
              changesetKind={changesetKind}
              entry={entry}
              key={`${changesetKey}|${changedFileKey(entry)}`}
              loadFileDiff={loadFileDiff}
              mode={mode}
              onLineComment={onLineComment}
              {...(reloadToken === undefined ? {} : { reloadToken })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
