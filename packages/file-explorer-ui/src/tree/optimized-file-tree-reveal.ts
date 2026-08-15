import type { IFileNode } from '@brainstrike/types';

/**
 * Pure reveal-convergence logic for pane-scoped trees (BST-1269), extracted
 * from `optimized-file-tree.tsx` (composition-module size budget). See the
 * consuming reveal effect there for the ref bookkeeping contract.
 */

/** Index of the last path separator ('/' or Windows '\\') in `path`. */
function lastSeparatorIndex(path: string): number {
  return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
}

/** Proper-prefix directory chain of `revealPath`, stopping at the root. */
function collectRevealAncestors(revealPath: string, rootPath: string | null): string[] {
  const ancestorPaths: string[] = [];
  let separatorIndex = lastSeparatorIndex(revealPath);
  while (separatorIndex > 0) {
    const prefix = revealPath.slice(0, separatorIndex);
    if (
      rootPath &&
      (prefix === rootPath ||
        rootPath.startsWith(`${prefix}/`) ||
        rootPath.startsWith(`${prefix}\\`))
    ) {
      break;
    }
    ancestorPaths.push(prefix);
    separatorIndex = lastSeparatorIndex(prefix);
  }
  return ancestorPaths;
}

export type RevealStep =
  | { kind: 'expand'; paths: string[] }
  | { kind: 'reveal' }
  | { kind: 'wait' };

/**
 * One pass of the reveal convergence loop (BST-1269): expand the RENDERED
 * collapsed ancestors not yet toggled for this target (deeper ones appear as
 * parents expand and lazy-load); wait while a toggled ancestor's expansion is
 * still landing; reveal once the chain is open. A collapsed directory TARGET
 * expands as part of its own reveal step.
 */
export function resolveRevealStep(args: {
  alreadyToggledPaths: ReadonlySet<string>;
  expandedPaths: ReadonlySet<string>;
  renderedNodesByPath: ReadonlyMap<string, IFileNode>;
  revealPath: string;
  rootPath: string | null;
}): RevealStep {
  const { alreadyToggledPaths, expandedPaths, renderedNodesByPath, revealPath, rootPath } = args;
  const ancestorPaths = collectRevealAncestors(revealPath, rootPath);
  const renderedCollapsed = ancestorPaths.filter(
    (path) => !expandedPaths.has(path) && renderedNodesByPath.has(path)
  );
  // A LOADING ancestor is never re-toggled — not even by a NEW reveal target
  // (a fresh toggled-set) — because toggling a loading directory means
  // "cancel the load" in the user-facing contract, which would wedge the
  // reveal it is loading for.
  const freshlyCollapsed = renderedCollapsed.filter(
    (path) =>
      !alreadyToggledPaths.has(path) && renderedNodesByPath.get(path)?.loadState !== 'loading'
  );
  if (freshlyCollapsed.length > 0) {
    return { kind: 'expand', paths: freshlyCollapsed };
  }
  if (renderedCollapsed.length > 0) {
    // A toggled ancestor is still loading — wait for its expansion to land.
    return { kind: 'wait' };
  }
  const targetNode = renderedNodesByPath.get(revealPath);
  if (!targetNode) {
    return { kind: 'wait' };
  }
  if (
    targetNode.type === 'directory' &&
    !expandedPaths.has(revealPath) &&
    !alreadyToggledPaths.has(revealPath) &&
    targetNode.loadState !== 'loading'
  ) {
    return { kind: 'expand', paths: [revealPath] };
  }
  return { kind: 'reveal' };
}
