/**
 * BST-1400 item 13: warns once per path when two mounted-root descriptors
 * resolve to the SAME path (a genuine duplicate mount, or a spelling
 * divergence the adapter never normalized — e.g. a macOS case variant).
 * Pulled out of `use-workspace-bar.ts` purely to stay under Biome's
 * file-line cap, mirroring `use-workspace-bar-write-derive.ts`'s extraction
 * for the same reason.
 */
import { createLogger } from '@brainstrike/logging';
import { useEffect, useRef } from 'react';

const logger = createLogger('WorkspaceBar');

export interface WorkspaceBarRootDescriptor {
  readonly displayName: string;
  readonly path: string;
}

/**
 * Groups adapter root ids by their descriptor's path. Pure — the log side
 * effect lives in `useDuplicatePathNotice` below, which calls this with the
 * same `rootDescriptors` `use-workspace-bar.ts`'s path→adapterId derivation
 * memoizes over.
 */
export function groupAdapterRootIdsByPath(
  rootDescriptors: Readonly<Record<string, WorkspaceBarRootDescriptor>> | undefined
): Map<string, string[]> {
  const byPath = new Map<string, string[]>();
  for (const [adapterRootId, descriptor] of Object.entries(rootDescriptors ?? {})) {
    const existing = byPath.get(descriptor.path);
    if (existing) {
      existing.push(adapterRootId);
    } else {
      byPath.set(descriptor.path, [adapterRootId]);
    }
  }
  return byPath;
}

/**
 * `use-workspace-bar.ts`'s `adapterRootIdByPath` is a last-write-wins Map:
 * two descriptors sharing a path silently collapse to whichever one iterated
 * last, with the other's working-tree refresh never registered — and nothing
 * explained why, since that root still LOOKS mounted everywhere else. Logs
 * ONCE per colliding path (not once per render) so a live re-mount loop
 * can't grow the noise unbounded, while a newly-seen collision still
 * surfaces.
 */
export function useDuplicatePathNotice(
  rootDescriptors: Readonly<Record<string, WorkspaceBarRootDescriptor>> | undefined
): void {
  const warnedPathsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    warnedPathsRef.current ??= new Set<string>();
    const warnedPaths = warnedPathsRef.current;
    // Filtered to NEWLY-seen collisions before the loop (rather than an
    // `if`-guarded `continue` inside it) so the loop body is unconditional —
    // an `if` block inside a dep-driven useEffect otherwise trips the
    // Biome plugin's "avoid state as event handler" heuristic.
    const newCollisions = [...groupAdapterRootIdsByPath(rootDescriptors)].filter(
      ([path, adapterRootIds]) => adapterRootIds.length > 1 && !warnedPaths.has(path)
    );
    for (const [path, adapterRootIds] of newCollisions) {
      warnedPaths.add(path);
      logger.warn(
        'two mounted roots share a path; the working-tree refresh registration for one of them was silently dropped',
        { adapterRootIds, path }
      );
    }
  }, [rootDescriptors]);
}
