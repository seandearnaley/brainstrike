/**
 * Workspace root/path resolution for the desktop native tools (BST-743):
 * normalize the open-folder root, resolve a model-supplied workspace path to a
 * contained absolute path (symlink-canonicalized + containment-checked), the
 * TOCTOU-stable read lock, and the leaf-mutation path used by delete/rename.
 * Extracted from `assistant-tools.ts` so every file-touching tool family shares
 * one resolution surface.
 *
 * Leaf module: depends only on node fs/path, `@brainstrike/agent`, and the pure
 * `workspace-path` string helpers — never on `assistant-tools.ts`, so no import
 * cycle is possible.
 */
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { type RuntimeData, withFileLock } from '@brainstrike/agent';
import { isWithinRoot, normalizeWorkspacePath } from './workspace-path.js';

export function normalizeWorkspaceRootPath(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || !path.isAbsolute(trimmed)) {
    return;
  }
  return path.resolve(trimmed);
}

export function resolveWorkspaceRootPath(runtimeData: RuntimeData | undefined): string {
  const rootPath = normalizeWorkspaceRootPath(runtimeData?.workspaceRootPath);
  if (!rootPath) {
    throw new Error(
      'No folder is open in the workspace. Add a folder in the left file tree first.'
    );
  }
  return rootPath;
}

export async function resolveWorkspaceAbsolutePath(
  rootPath: string,
  workspacePath: string
): Promise<{ workspacePath: string; absolutePath: string }> {
  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  const relativePath =
    normalizedWorkspacePath === '/' ? '' : normalizedWorkspacePath.replace(/^\/+/, '');
  const absolutePath = path.resolve(rootPath, relativePath);
  // Resolve symlinks on both sides, then check containment on the canonical
  // paths. ".." can't escape (clamped in normalizeWorkspacePath); this guards
  // the remaining vector — a symlink whose target lives outside the root.
  const canonicalRootPath = await fsPromises.realpath(rootPath);
  const canonicalAbsolutePath = await fsPromises.realpath(absolutePath);
  if (!isWithinRoot(canonicalRootPath, canonicalAbsolutePath)) {
    throw new Error(`Path "${workspacePath}" is outside the selected workspace root.`);
  }
  return {
    absolutePath: canonicalAbsolutePath,
    workspacePath: normalizedWorkspacePath,
  };
}

const MAX_STABLE_WORKSPACE_FILE_LOCK_ATTEMPTS = 3;

export async function withStableWorkspaceFileLock<T>(
  rootPath: string,
  requestedPath: string,
  task: (resolved: { readonly absolutePath: string; readonly workspacePath: string }) => Promise<T>
): Promise<T> {
  for (let attempt = 0; attempt < MAX_STABLE_WORKSPACE_FILE_LOCK_ATTEMPTS; attempt += 1) {
    const resolvedBeforeLock = await resolveWorkspaceAbsolutePath(rootPath, requestedPath);
    const result = await withFileLock(resolvedBeforeLock.absolutePath, async () => {
      const resolvedAfterLock = await resolveWorkspaceAbsolutePath(rootPath, requestedPath);
      if (resolvedAfterLock.absolutePath !== resolvedBeforeLock.absolutePath) {
        return { kind: 'retry' as const };
      }
      return { kind: 'complete' as const, value: await task(resolvedAfterLock) };
    });
    if (result.kind === 'complete') {
      return result.value;
    }
  }
  throw new Error(
    `Path "${requestedPath}" changed targets repeatedly while waiting to read it. Retry the read.`
  );
}

/**
 * Resolve the on-disk path that a delete/rename should MUTATE. Unlike the write
 * tools — which correctly resolve THROUGH a symlink to write its target — a
 * delete/rename must act on the symlink itself: unlinking removes the pointer
 * (never the target file) and renaming moves the pointer. `resolveWorkspaceWritePath`
 * realpaths an existing leaf, so its `absolutePath` is the TARGET for a live
 * in-root symlink. Here we canonicalize only the leaf's PARENT and re-append the
 * leaf name, so the result is the LINK's own location for a symlink leaf (live or
 * dangling) and the file's canonical location for a regular file. The parent's
 * realpath is containment-checked (a symlinked parent escaping the root is
 * refused, mirroring `ensureContainedDirectory`); a LIVE symlink whose TARGET
 * escapes the root is already refused upstream by `resolveWorkspaceWritePath`
 * (realpath-then-containment), so it never reaches this helper.
 */
export async function resolveWorkspaceLeafMutationPath(
  canonicalRootPath: string,
  requestedAbsolutePath: string,
  workspacePath: string
): Promise<string> {
  let canonicalParent: string;
  try {
    canonicalParent = await fsPromises.realpath(path.dirname(requestedAbsolutePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Path "${workspacePath}" does not exist.`);
    }
    throw error;
  }
  if (!isWithinRoot(canonicalRootPath, canonicalParent)) {
    throw new Error(`Path "${workspacePath}" is outside the selected workspace root.`);
  }
  return path.join(canonicalParent, path.basename(requestedAbsolutePath));
}
