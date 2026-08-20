/**
 * Renderer live-refresh subscription: one refcounted owner feeds
 * `useChangesLiveRefreshStore` from BOTH the `changes:invalidated` git-metadata
 * push channel and the canonical `FILE_EXPLORER_REFRESH_EVENT` working-tree
 * pipeline, no matter how many data hooks are mounted.
 *
 * REFCOUNTED on purpose: `useChangeset` and `useGitInventory` each call
 * {@link useChangesLiveRefreshSubscription}, and several instances of both can
 * be mounted at once (Changes surface + git panel). The first acquirer
 * subscribes `bridge.onInvalidated`; the last release unsubscribes. State is
 * module-scoped but mutated only from effects — never at import time (the
 * chunk-init hazard class).
 *
 * Each mounted Git-scope changeset registers its root/repository/worktree
 * identity. File-explorer events are mapped only through those authoritative
 * registrations; no inventory load, new IPC, polling, or workspace-wide
 * fallback is introduced. This is what preserves `useGitInventory`'s deferred
 * first-load gate while keeping already-open Git views fresh.
 */
import {
  FILE_EXPLORER_REFRESH_EVENT,
  type FileExplorerRefreshEvent,
  type FileExplorerRefreshRootDetail,
} from '@brainstrike/file-explorer-ui/shell';
import { createLogger } from '@brainstrike/logging';
import { useEffect } from 'react';
import { resolveChangesBridge } from './changes-bridge';
import { useChangesLiveRefreshStore } from './changes-live-refresh-store';

const logger = createLogger('ChangesLiveRefresh');

let subscriberCount = 0;
let unsubscribeFromBridge: (() => void) | null = null;
let nextRegistrationId = 1;
const gitScopeRegistrations = new Map<number, NormalizedGitScopeRefreshRegistration>();

export interface GitScopeRefreshRegistration {
  readonly repositoryRoot: string;
  readonly rootId: string;
  readonly worktreePath: string;
}

interface NormalizedGitScopeRefreshRegistration extends GitScopeRefreshRegistration {
  readonly normalizedRepositoryRoot: string;
  readonly normalizedWorktreePath: string;
}

interface NormalizedRefreshRoot {
  readonly detail: FileExplorerRefreshRootDetail;
  readonly normalizeChangePath: (
    change: FileExplorerRefreshRootDetail['changes'][number]
  ) => string;
  readonly normalizedRootPath: string;
  readonly normalizeFilteredBoundary: (boundary: string) => string;
}

interface RegistrationGroup {
  readonly normalizedWorktreePath: string;
  readonly repositoryRoots: Set<string>;
  readonly rootId: string;
}

export function normalizeRefreshPath(path: string): string {
  const withSlashes = path.replaceAll('\\', '/');
  if (/^[A-Za-z]:\/+$/u.test(withSlashes)) {
    return `${withSlashes.slice(0, 2)}/`;
  }
  if (/^\/+$/u.test(withSlashes)) {
    return '/';
  }
  return withSlashes.replace(/\/+$/u, '');
}

function isAbsolutePathLike(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//u.test(path);
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:\//u.test(path) || path.startsWith('//');
}

function normalizedPathForComparison(normalized: string): string {
  return isWindowsPath(normalized) ? normalized.toLowerCase() : normalized;
}

function normalizeRefreshPathForComparison(path: string): string {
  return normalizedPathForComparison(normalizeRefreshPath(path));
}

function isNormalizedPathContained(base: string, target: string): boolean {
  if (base.length === 0 || target.length === 0) {
    return false;
  }
  if (base === '/' || /^[a-z]:\/$/u.test(base)) {
    return target.startsWith(base);
  }
  return target === base || target.startsWith(`${base}/`);
}

function resolveChangePath(normalizedRootPath: string, changePath: string): string {
  const normalizedChangePath = normalizeRefreshPath(changePath);
  if (isAbsolutePathLike(normalizedChangePath)) {
    return normalizedPathForComparison(normalizedChangePath);
  }
  const relativePath = normalizedChangePath.replace(/^\.\//u, '').replace(/^\/+/u, '');
  const separator = normalizedRootPath.endsWith('/') ? '' : '/';
  return normalizedPathForComparison(`${normalizedRootPath}${separator}${relativePath}`);
}

function normalizeRefreshRoot(root: FileExplorerRefreshRootDetail): NormalizedRefreshRoot {
  const normalizedRootPath = normalizeRefreshPathForComparison(root.rootPath);
  const normalizedChangePaths = new Map<FileExplorerRefreshRootDetail['changes'][number], string>();
  const normalizedFilteredBoundaries = new Map<string, string>();
  return {
    detail: root,
    normalizeChangePath: (change) => {
      const cached = normalizedChangePaths.get(change);
      if (cached !== undefined) {
        return cached;
      }
      const normalized = resolveChangePath(normalizedRootPath, change.path);
      normalizedChangePaths.set(change, normalized);
      return normalized;
    },
    normalizedRootPath,
    normalizeFilteredBoundary: (boundary) => {
      const cached = normalizedFilteredBoundaries.get(boundary);
      if (cached !== undefined) {
        return cached;
      }
      const normalized = resolveChangePath(normalizedRootPath, boundary);
      normalizedFilteredBoundaries.set(boundary, normalized);
      return normalized;
    },
  };
}

function rootRefreshAffectsRegistrationGroup(
  root: NormalizedRefreshRoot,
  scope: FileExplorerRefreshEvent['detail']['scope'],
  registration: RegistrationGroup
): boolean {
  if (scope === 'full') {
    return true;
  }
  if (root.detail.filteredChangeBoundariesOverflow === true) {
    // Boundary evidence exceeded the typed finite cap. RootId remains the
    // lossless authority, so fail open only across mounted Git scopes in this
    // durable root. This is NOT watcher record loss and drives no tree/index scan.
    return true;
  }
  const pathsShareVocabulary =
    isNormalizedPathContained(root.normalizedRootPath, registration.normalizedWorktreePath) ||
    isNormalizedPathContained(registration.normalizedWorktreePath, root.normalizedRootPath);
  if (!pathsShareVocabulary) {
    // `rootId` is the durable authority. Desktop watcher paths are re-rooted
    // onto the user-facing handle path while inventory worktrees can be
    // realpath'd; when those vocabularies cannot be related lexically, path
    // filtering would silently miss the repository. Refresh every registered
    // repository in this durable root instead (safe extra work, never stale).
    return true;
  }
  const intersectsRegistration = (changedPath: string): boolean =>
    // A changed descendant edits repository content. A changed ancestor can
    // add/remove/replace the worktree directory itself, so it also intersects
    // the repository and must refresh it.
    isNormalizedPathContained(registration.normalizedWorktreePath, changedPath) ||
    isNormalizedPathContained(changedPath, registration.normalizedWorktreePath);
  for (const change of root.detail.changes) {
    if (intersectsRegistration(root.normalizeChangePath(change))) {
      return true;
    }
  }
  for (const boundary of root.detail.filteredChangeBoundaries ?? []) {
    if (intersectsRegistration(root.normalizeFilteredBoundary(boundary))) {
      return true;
    }
  }
  return false;
}

function groupRegistrations(
  registrations: readonly NormalizedGitScopeRefreshRegistration[]
): readonly RegistrationGroup[] {
  const groups = new Map<string, RegistrationGroup>();
  for (const registration of registrations) {
    const key = `${registration.rootId}\0${registration.normalizedWorktreePath}\0${registration.normalizedRepositoryRoot}`;
    const existing = groups.get(key);
    if (existing) {
      existing.repositoryRoots.add(registration.repositoryRoot);
      continue;
    }
    groups.set(key, {
      normalizedWorktreePath: registration.normalizedWorktreePath,
      repositoryRoots: new Set([registration.repositoryRoot]),
      rootId: registration.rootId,
    });
  }
  return [...groups.values()];
}

function affectedRepositoryRoots(event: FileExplorerRefreshEvent): readonly string[] {
  const registrations = [...gitScopeRegistrations.values()];
  if (event.detail.scope === 'full' && event.detail.roots.length === 0) {
    // Canonical manual refresh broadcasts use an empty roots tuple to mean
    // every mounted root; the active registrations are the exact consumer set.
    return [...new Set(registrations.map((entry) => entry.repositoryRoot))];
  }
  const rootsById = new Map<string, NormalizedRefreshRoot[]>();
  for (const root of event.detail.roots) {
    const normalizedRoot = normalizeRefreshRoot(root);
    const matchingRoots = rootsById.get(root.rootId) ?? [];
    matchingRoots.push(normalizedRoot);
    rootsById.set(root.rootId, matchingRoots);
  }
  const affected = new Set<string>();
  for (const registration of groupRegistrations(registrations)) {
    if ([...registration.repositoryRoots].every((root) => affected.has(root))) {
      continue;
    }
    const roots = rootsById.get(registration.rootId);
    if (
      roots?.some((root) =>
        rootRefreshAffectsRegistrationGroup(root, event.detail.scope, registration)
      ) !== true
    ) {
      continue;
    }
    for (const repositoryRoot of registration.repositoryRoots) {
      affected.add(repositoryRoot);
    }
  }
  return [...affected];
}

const handleFileExplorerRefresh = (event: Event): void => {
  const refreshEvent = event as FileExplorerRefreshEvent;
  const affected = affectedRepositoryRoots(refreshEvent);
  if (affected.length === 0) {
    return;
  }
  useChangesLiveRefreshStore.getState().ingestWorkingTreeRefresh(affected);
};

/**
 * Acquire one reference on the shared bridge subscription. Returns the
 * release function (idempotent per acquisition). Exported for tests; hooks
 * use {@link useChangesLiveRefreshSubscription}.
 */
export function acquireChangesLiveRefreshSubscription(
  registration: GitScopeRefreshRegistration | null = null
): () => void {
  const registrationId = registration ? nextRegistrationId++ : null;
  if (registrationId !== null && registration) {
    gitScopeRegistrations.set(registrationId, {
      ...registration,
      normalizedRepositoryRoot: normalizeRefreshPathForComparison(registration.repositoryRoot),
      normalizedWorktreePath: normalizeRefreshPathForComparison(registration.worktreePath),
    });
  }
  subscriberCount += 1;
  if (subscriberCount === 1) {
    window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, handleFileExplorerRefresh);
    const bridge = resolveChangesBridge();
    if (bridge) {
      // Guarded (PR #2288 review): this runs inside a useEffect body, so a
      // throw here would skip React's cleanup and strand the count above
      // zero with no live subscription — wedging the channel silently for
      // the session. Log LOUDLY instead; once every holder releases, the
      // next acquire retries a fresh subscribe.
      try {
        unsubscribeFromBridge = bridge.onInvalidated((event) => {
          // Do NOT pre-register active renderer repository strings here. A
          // git-panel changeset may carry a symlink spelling while the wire
          // event carries the inventory's canonical realpath. Keeping that
          // key unknown preserves selectGitScopeRefreshNonce's deliberate
          // conservative path-vocabulary guard.
          useChangesLiveRefreshStore.getState().ingestInvalidation(event);
        });
      } catch (error) {
        logger.error('changes live-refresh: bridge subscription failed; push refresh disabled', {
          error,
        });
        unsubscribeFromBridge = null;
      }
    }
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    if (registrationId !== null) {
      gitScopeRegistrations.delete(registrationId);
    }
    subscriberCount -= 1;
    if (subscriberCount === 0) {
      window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, handleFileExplorerRefresh);
      unsubscribeFromBridge?.();
      unsubscribeFromBridge = null;
    }
  };
}

/** Hold the shared dual-source live-refresh owner while mounted. */
export function useChangesLiveRefreshSubscription(
  registration: GitScopeRefreshRegistration | null = null
): void {
  const repositoryRoot = registration?.repositoryRoot ?? null;
  const rootId = registration?.rootId ?? null;
  const worktreePath = registration?.worktreePath ?? null;
  useEffect(
    () =>
      acquireChangesLiveRefreshSubscription(
        repositoryRoot && rootId && worktreePath ? { repositoryRoot, rootId, worktreePath } : null
      ),
    [repositoryRoot, rootId, worktreePath]
  );
}
