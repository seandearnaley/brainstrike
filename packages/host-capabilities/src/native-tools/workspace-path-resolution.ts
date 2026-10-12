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
import { ToolInputError } from '@brainstrike/assistant-contract';
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
    throw new ToolInputError(
      'No folder is open in the workspace. Add a folder in the left file tree first.'
    );
  }
  return rootPath;
}

/** The model's path under the root, before any symlink is resolved. */
function requestedAbsolutePath(
  rootPath: string,
  workspacePath: string
): { normalizedWorkspacePath: string; absolutePath: string } {
  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  const relativePath =
    normalizedWorkspacePath === '/' ? '' : normalizedWorkspacePath.replace(/^\/+/, '');
  return { absolutePath: path.resolve(rootPath, relativePath), normalizedWorkspacePath };
}

export async function resolveWorkspaceAbsolutePath(
  rootPath: string,
  workspacePath: string
): Promise<{ workspacePath: string; absolutePath: string }> {
  const { absolutePath, normalizedWorkspacePath } = requestedAbsolutePath(rootPath, workspacePath);
  // Resolve symlinks on both sides, then check containment on the canonical
  // paths. ".." can't escape (clamped in normalizeWorkspacePath); this guards
  // the remaining vector — a symlink whose target lives outside the root.
  const canonicalRootPath = await fsPromises.realpath(rootPath);
  const canonicalAbsolutePath = await fsPromises.realpath(absolutePath);
  if (!isWithinRoot(canonicalRootPath, canonicalAbsolutePath)) {
    throw outsideWorkspaceRootRefusal(workspacePath);
  }
  return {
    absolutePath: canonicalAbsolutePath,
    workspacePath: normalizedWorkspacePath,
  };
}

/** Why a workspace read refused a model-supplied path. */
export type WorkspacePathRefusalReason =
  | 'binary'
  | 'missing'
  | 'not-file'
  | 'outside'
  | 'too-large';

/**
 * BST-1996: a read's refusal of a model-supplied path, typed by reason so a
 * caller decides by type, never by message text (BST-1985). The message names
 * only the path the model sent.
 */
export class WorkspacePathRefusal extends ToolInputError {
  constructor(
    readonly reason: WorkspacePathRefusalReason,
    message: string
  ) {
    super(message);
    this.name = 'WorkspacePathRefusal';
  }
}

function outsideWorkspaceRootRefusal(workspacePath: string): WorkspacePathRefusal {
  return new WorkspacePathRefusal(
    'outside',
    `Path "${workspacePath}" is outside the selected workspace root.`
  );
}

/**
 * BST-1996: the refusal for a model-supplied path that does not exist. A missing
 * path is the model's to correct only inside the root. Containment is decided on
 * where the path would be, through every symlink on the way, including a
 * dangling one, so a link that leaves the root gets the containment refusal
 * whether or not its outside target exists. Both echo only the model's path.
 */
export async function missingWorkspacePathRefusal(
  rootPath: string,
  workspacePath: string
): Promise<WorkspacePathRefusal> {
  const { absolutePath } = requestedAbsolutePath(rootPath, workspacePath);
  const canonicalRootPath = await fsPromises.realpath(rootPath);
  const intended = await resolveIntendedPath(absolutePath, MAX_SYMLINK_HOPS);
  return isWithinRoot(canonicalRootPath, intended)
    ? new WorkspacePathRefusal('missing', `Path "${workspacePath}" does not exist.`)
    : outsideWorkspaceRootRefusal(workspacePath);
}

/** The most links followed before a dangling chain is treated as a loop, as the OS does. */
const MAX_SYMLINK_HOPS = 40;

/**
 * Where a path that does not fully exist would be: `realpath` for the part that
 * exists, with each symlink on the way followed even when its target is missing.
 */
async function resolveIntendedPath(target: string, hops: number): Promise<string> {
  let entry: Awaited<ReturnType<typeof fsPromises.lstat>> | undefined;
  try {
    entry = await fsPromises.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  if (!entry) {
    const parent = path.dirname(target);
    if (parent === target) {
      return target;
    }
    return path.join(await resolveIntendedPath(parent, hops), path.basename(target));
  }
  if (!entry.isSymbolicLink()) {
    return await fsPromises.realpath(target);
  }
  if (hops === 0) {
    throw new Error('Too many symbolic links while resolving a workspace path.');
  }
  const link = await fsPromises.readlink(target);
  return await resolveIntendedPath(path.resolve(path.dirname(target), link), hops - 1);
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
      throw new ToolInputError(`Path "${workspacePath}" does not exist.`);
    }
    throw error;
  }
  if (!isWithinRoot(canonicalRootPath, canonicalParent)) {
    throw new ToolInputError(`Path "${workspacePath}" is outside the selected workspace root.`);
  }
  return path.join(canonicalParent, path.basename(requestedAbsolutePath));
}
