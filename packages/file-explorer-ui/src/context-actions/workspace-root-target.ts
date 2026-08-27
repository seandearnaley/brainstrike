import type { TargetOf } from '@brainstrike/context-actions';

export interface WorkspaceRootTargetInput {
  readonly displayName: string;
  readonly isMain: boolean;
  /**
   * The root handle's `path`. On desktop this is the absolute filesystem
   * path; on web an FSA handle reports its NAME here, which is not a path at
   * all — see the normalization below.
   */
  readonly path?: string | undefined;
  readonly rootId: string;
}

/**
 * Root section header → immutable invocation snapshot, claimed synchronously
 * in the `contextmenu` event (ui-conventions: targets are snapshots, never
 * live store lookups).
 *
 * The ONE normalization: a `path` equal to the display name is reported as
 * `null`. `RootSectionHeader` already applies exactly that test before
 * rendering its path tooltip, because a web FSA root's `path` IS its name.
 * Without it, "Copy Path" on web would copy a bare folder name and "Reveal"
 * would hand the shell a non-path.
 */
export function workspaceRootToTarget({
  displayName,
  isMain,
  path,
  rootId,
}: WorkspaceRootTargetInput): TargetOf<'workspace-root'> {
  return {
    displayName,
    isMain,
    kind: 'workspace-root',
    path: path && path !== displayName ? path : null,
    rootId,
  };
}
