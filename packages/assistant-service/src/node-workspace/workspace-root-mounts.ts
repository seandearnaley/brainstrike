import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import { isContained, pathsEqual } from './workspace-root-paths.js';
import type {
  MountedWorkspaceRoot,
  SecureWorkspaceRoot,
  StoredWorkspaceRoot,
} from './workspace-root-types.js';

// Shared with the registry so its own warnings stay under one scope.
const logger = createLogger('WorkspaceRootRegistry');

/**
 * Owns the live secure-root capabilities and the session/persisted split —
 * both halves of that state, including the session-flag lifecycle (see
 * `unmount`).
 * Every capability close in the registry funnels through here, so "which
 * rootIds are mounted" and "who may close a capability" have exactly one
 * home. Lookups are lexical only — realpath authorization stays in
 * workspace-root-read.
 */
export class WorkspaceRootMountTable {
  private readonly mounted = new Map<string, MountedWorkspaceRoot>();
  private readonly sessionRootIds = new Set<string>();

  get(rootId: string): MountedWorkspaceRoot | undefined {
    return this.mounted.get(rootId);
  }

  has(rootId: string): boolean {
    return this.mounted.has(rootId);
  }

  /** Snapshot: callers mutate the table while iterating. */
  ids(): string[] {
    return [...this.mounted.keys()];
  }

  /** Snapshot: callers mutate the table while iterating. */
  snapshot(): MountedWorkspaceRoot[] {
    return [...this.mounted.values()];
  }

  isSessionMount(rootId: string): boolean {
    return this.sessionRootIds.has(rootId);
  }

  markSessionMount(rootId: string): void {
    this.sessionRootIds.add(rootId);
  }

  clearSessionMount(rootId: string): void {
    this.sessionRootIds.delete(rootId);
  }

  sessionMountIds(): Set<string> {
    return new Set(this.sessionRootIds);
  }

  /** Presentation paths of the mounts the database is allowed to converge on. */
  persistedMountedPaths(excludeRootId?: string): string[] {
    const paths: string[] = [];
    for (const mounted of this.mounted.values()) {
      if (mounted.rootId !== excludeRootId && !this.sessionRootIds.has(mounted.rootId)) {
        paths.push(mounted.presentationPath);
      }
    }
    return paths;
  }

  findByCanonicalPath(canonicalPath: string): MountedWorkspaceRoot | undefined {
    return this.snapshot().find((candidate) => pathsEqual(candidate.canonicalPath, canonicalPath));
  }

  findByPresentationPath(presentationPath: string): MountedWorkspaceRoot | undefined {
    return this.snapshot().find((candidate) =>
      pathsEqual(candidate.presentationPath, presentationPath)
    );
  }

  findByEitherPath(candidatePath: string): MountedWorkspaceRoot | undefined {
    return this.snapshot().find(
      (candidate) =>
        pathsEqual(candidate.presentationPath, candidatePath) ||
        pathsEqual(candidate.canonicalPath, candidatePath)
    );
  }

  install(entry: StoredWorkspaceRoot, secureRoot: SecureWorkspaceRoot): string {
    const canonicalPath = path.normalize(secureRoot.canonicalPath);
    const presentationPath = path.normalize(entry.path);
    const current = this.mounted.get(entry.rootId);
    if (
      current &&
      pathsEqual(current.canonicalPath, canonicalPath) &&
      pathsEqual(current.presentationPath, presentationPath)
    ) {
      // Post-open incumbent check (not the deleted pre-claim check —
      // identity still comes from the opened probe's own canonicalPath):
      // the incumbent capability already serves this exact identity, so
      // keep it live — its open readers/handles stay valid — and discard
      // the redundant, freshly-opened probe instead of severing them.
      // Guarded on object identity: if the caller handed us the SAME
      // capability object as the incumbent, it is not redundant — closing
      // it would sever the live mount.
      if (secureRoot !== current.root) {
        try {
          secureRoot.close();
        } catch (error) {
          logger.warn('Failed to close a redundant workspace root capability', { error });
        }
      }
      return canonicalPath;
    }
    this.mounted.set(entry.rootId, {
      canonicalPath,
      presentationPath,
      root: secureRoot,
      rootId: entry.rootId,
    });
    if (current && current.root !== secureRoot) {
      closeMountedRoot(current);
    }
    return canonicalPath;
  }

  /**
   * Clears the session flag with the mount, so "unmounted" can never leave a
   * stale session id behind for a later mount of the same rootId to inherit —
   * `persistedMountedPaths()` would then silently omit a live persisted root
   * and `markRootsDisconnectedExcept` would demote it in the database. No
   * caller reaches that state today (review on #2584 traced it unreachable);
   * enforcing it here is what makes the claim above true of this class rather
   * than of its callers.
   */
  unmount(rootId: string): void {
    this.sessionRootIds.delete(rootId);
    const mounted = this.mounted.get(rootId);
    if (!mounted) {
      return;
    }
    this.mounted.delete(rootId);
    closeMountedRoot(mounted);
  }

  closeAll(): void {
    for (const mounted of this.mounted.values()) {
      closeMountedRoot(mounted);
    }
    this.mounted.clear();
    this.sessionRootIds.clear();
  }

  /**
   * Resolves the mounted root for a read, given an optional caller-supplied
   * rootId. A stale/wrong rootId (e.g. held across a remount) still resolves
   * when `requestedPath` is itself absolute: it falls back to the same
   * path-anchored lookup the no-rootId path already uses
   * (findForAbsolutePath). This is NOT a security downgrade — the fallback
   * still goes through the identical containment check and realpath
   * preflight in workspace-root-read; only the requested rootId's authority
   * is treated as fungible with "an absolute path that resolves into some
   * mounted root", never a relaxation of what paths are readable. A relative
   * path with an unknown rootId has no other anchor and keeps throwing.
   */
  resolveForRead(
    requestedPath: string,
    rootId: string | undefined
  ): MountedWorkspaceRoot | undefined {
    if (rootId === undefined) {
      return this.findForAbsolutePath(requestedPath);
    }
    const mounted = this.mounted.get(rootId);
    if (mounted) {
      return mounted;
    }
    if (path.isAbsolute(requestedPath)) {
      return this.findForAbsolutePath(requestedPath);
    }
    return;
  }

  /** Deepest containing root wins, so nested roots resolve to the inner one. */
  private findForAbsolutePath(requestedPath: string): MountedWorkspaceRoot | undefined {
    const normalized = path.normalize(requestedPath);
    return this.snapshot()
      .filter(
        (candidate) =>
          isContained(candidate.presentationPath, normalized) ||
          isContained(candidate.canonicalPath, normalized)
      )
      .sort(
        (left, right) =>
          Math.max(right.presentationPath.length, right.canonicalPath.length) -
          Math.max(left.presentationPath.length, left.canonicalPath.length)
      )[0];
  }
}

function closeMountedRoot(mounted: MountedWorkspaceRoot): void {
  try {
    mounted.root.close();
  } catch (error) {
    logger.warn('Failed to close a workspace root capability', {
      error,
      rootId: mounted.rootId,
    });
  }
}
