/**
 * Human labels for a `GitScope` (BST-1114). Split out of
 * `changeset-source-picker.tsx` so that component file exports components
 * only (`react-doctor/only-export-components`) — shared by the picker itself
 * and `changeset-header.tsx`'s provenance line.
 */
import type { GitScope } from '@brainstrike/types';

/** Human label for a `GitScope`. */
export function describeGitScopeKind(scope: GitScope): string {
  switch (scope.kind) {
    case 'uncommitted':
      return 'uncommitted';
    case 'staged':
      return 'staged';
    case 'unstaged':
      return 'unstaged';
    case 'branch-vs-base':
      return scope.baseRef ? `vs ${scope.baseRef}` : 'vs base branch';
    case 'commit':
      return `commit ${scope.commitId.slice(0, 7)}`;
    default: {
      const exhaustive: never = scope;
      throw new Error(`Unhandled GitScope kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
