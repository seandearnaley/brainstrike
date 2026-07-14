import { DiffView, parseUnifiedDiff } from '@brainstrike/ui';
import type { ReactElement } from 'react';
import type { LoadedDiff } from './use-git-panel';

export type GitDiffSurfaceState =
  | { readonly kind: 'empty'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loading'; readonly message: string }
  | { readonly diff: LoadedDiff; readonly kind: 'loaded'; readonly path: string };

export function GitDiffSurface({ state }: { readonly state: GitDiffSurfaceState }): ReactElement {
  if (state.kind !== 'loaded') {
    return (
      <div
        className={`grid h-full min-h-0 place-items-center px-8 text-center text-sm ${
          state.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'
        }`}
        data-testid={state.kind === 'error' ? 'git-panel-diff-error' : undefined}
      >
        <div className="max-w-sm leading-relaxed">{state.message}</div>
      </div>
    );
  }

  const parsed = parseUnifiedDiff(state.diff.unifiedDiff);
  if (!parsed.hasHunks) {
    return (
      <div
        className="grid h-full place-items-center px-8 text-center text-muted-foreground text-sm"
        data-testid="git-panel-no-textual-diff"
      >
        No textual changes to display for {state.path}.
      </div>
    );
  }

  return (
    <DiffView
      ariaLabel={`Diff for ${state.path}`}
      filename={state.path}
      key={state.path}
      modified={parsed.modified}
      original={parsed.original}
      testId="git-panel-diff"
      truncated={state.diff.truncated}
    />
  );
}
