/**
 * ADR-0034 scratch threads: the folders the host makes for threads sent with
 * no folder while none is open. A platform composes this with its root
 * registry, which mounts and records each folder, and its system Trash.
 *
 * - A folder is made under one directory, the platform's (the desktop's is
 *   `<userData>/scratch`, which a factory reset deletes), named as managed
 *   worktrees are. Its leaf is made alone, never with its parents, so it is
 *   always a folder that did not exist; a name already there is skipped.
 * - At that moment the host records it as trusted, through the one writer of
 *   trust (ADR-0032, owner decisions 2026-11-10). A folder the thread already
 *   has is reused and never trusted again.
 * - A deleted thread's folder leaves the workspace, then its trust answer goes
 *   and it moves to the system Trash.
 * - A folder the person turns into a project moves out to the place they
 *   chose (ADR-0034 build decisions), and is no longer a scratch folder.
 */
import { lstat, mkdir, readdir, realpath, rename, rmdir } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { refusalError } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { HostScratchFolder, HostScratchFolders } from './ports.ts';
import {
  forgetHostWorkspaceTrust,
  type HostWorkspaceTrustStore,
  writeHostWorkspaceTrust,
} from './workspace-trust.ts';

const logger = createLogger('HostScratchFolders');

/** The platform's root registry: the one writer of the roots, their mounts and their records. */
export interface HostScratchFolderRoots {
  /**
   * The thread's scratch folder, mounted: the one recorded for it, else, while
   * no folder is open, the folder `make` creates, recorded as the thread's in
   * the commit that records its root. Null, without calling `make`, while a
   * folder is open. Runs in the registry's own order of changes, so a folder
   * opened meanwhile is seen.
   */
  add(request: {
    readonly make: () => Promise<string>;
    readonly signal: AbortSignal;
    readonly threadId: string;
  }): Promise<HostScratchFolder | null>;
  /** Unmounts the thread's scratch folder and deletes its root and record; what it deleted. */
  forget(threadId: string): Promise<{ readonly path: string } | null>;
  /**
   * ADR-0034 build decisions: the thread's scratch folder leaves its mount, `move` moves it and
   * resolves where it now is, and its root becomes a folder of the person's there under the same
   * id, mounted again. A move that fails leaves the folder mounted where it was, and a record
   * that fails after the move says where the folder now is. One change among the registry's.
   */
  promote(request: {
    readonly move: (folder: string) => Promise<string>;
    readonly threadId: string;
  }): Promise<HostScratchFolder>;
  /** The thread's scratch folder as recorded; reads only. */
  read(threadId: string): Promise<HostScratchFolder | null>;
}

export interface HostScratchFolderOptions {
  /** Where every scratch folder is made; made itself when the first is. */
  readonly directory: string;
  /** An unused folder name, as managed worktrees are named (`generateWorktreeName`). */
  readonly name: (taken: ReadonlySet<string>) => string;
  /** Main's native folder picker: the folder chosen, or null when the person cancelled. */
  readonly pickFolder: () => Promise<string | null>;
  /** Test seam; production moves a folder with `fs.promises.rename`. */
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly roots: HostScratchFolderRoots;
  readonly store: HostWorkspaceTrustStore;
  /** Moves the folder at `path` to the system Trash. */
  readonly trash: (path: string) => Promise<void>;
}

const isCode = (cause: unknown, code: string): boolean =>
  cause instanceof Error && 'code' in cause && cause.code === code;

/**
 * Makes a new folder under `directory` and records it as trusted; its path. The path is
 * canonical, so the folder's root, its watch and its trust answer spell it the same way.
 */
async function makeFolder(options: HostScratchFolderOptions, signal: AbortSignal): Promise<string> {
  await mkdir(options.directory, { recursive: true });
  const directory = await realpath(options.directory);
  const taken = new Set(await readdir(directory));
  for (;;) {
    signal.throwIfAborted();
    const name = options.name(taken);
    const folder = join(directory, name);
    try {
      await mkdir(folder);
    } catch (cause) {
      if (isCode(cause, 'EEXIST')) {
        taken.add(name);
        continue;
      }
      throw cause;
    }
    try {
      await writeHostWorkspaceTrust(options.store, folder, 'trusted');
    } catch (cause) {
      await undoFolder(options, folder, cause);
    }
    return folder;
  }
}

/** Removes a folder made for a thread that will not have it, then rethrows why. */
async function undoFolder(
  options: HostScratchFolderOptions,
  folder: string,
  cause: unknown
): Promise<never> {
  try {
    await forgetHostWorkspaceTrust(options.store, folder);
    // Nothing has written to it yet: an empty folder is removed, and anything else is an error.
    await rmdir(folder);
  } catch (cleanup) {
    throw new AggregateError(
      [cause, cleanup],
      `The scratch folder ${folder} was not used, and could not be removed`
    );
  }
  throw cause;
}

/** The canonical path at `target`, or undefined when nothing is there. */
async function canonical(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch (cause) {
    if (isCode(cause, 'ENOENT')) {
      return;
    }
    throw cause;
  }
}

/** Whether anything, a dangling link included, is at `target`. */
async function occupied(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (cause) {
    if (isCode(cause, 'ENOENT')) {
      return false;
    }
    throw cause;
  }
}

const placeTaken = (destination: string) =>
  refusalError(
    'conflict',
    'workspace.scratch-project-exists',
    `${destination} already exists, so the scratch folder was not moved there.`,
    'Choose another folder, or move or rename what is there.'
  );

/**
 * ADR-0034 build decisions: moves a thread's scratch folder into `parent`, under its own name,
 * and resolves where it now is. Only a folder directly inside the scratch directory moves, both
 * compared at their canonical paths, as Main moves only such a folder to the Trash. It is one
 * rename: a place already taken is refused, and so is another disk, where a rename cannot go,
 * with no copy made instead. A folder inside the scratch directory is no place for a project.
 */
async function moveIntoProject(
  options: HostScratchFolderOptions,
  folder: string,
  parent: string
): Promise<string> {
  const [directory, resolved, chosen] = await Promise.all([
    realpath(options.directory),
    canonical(folder),
    canonical(parent),
  ]);
  if (resolved === undefined || dirname(resolved) !== directory) {
    throw refusalError(
      'authorization',
      'workspace.scratch-outside',
      `${folder} is not a scratch folder, so it was not moved.`
    );
  }
  if (chosen === undefined) {
    throw refusalError(
      'input',
      'workspace.scratch-project-parent-missing',
      `${parent} is no longer there, so the scratch folder was not moved.`
    );
  }
  if (chosen === directory || chosen.startsWith(`${directory}${sep}`)) {
    throw refusalError(
      'input',
      'workspace.scratch-project-inside',
      `${parent} is among Brainstrike's scratch folders, so the folder was not moved there.`,
      'Choose a folder of your own.'
    );
  }
  const destination = join(parent, basename(resolved));
  if (await occupied(destination)) {
    throw placeTaken(destination);
  }
  // Said before the move, so a host that stops before the record commits leaves a trace of where.
  logger.info('Moving a scratch folder into a project', { destination, folder: resolved });
  try {
    await (options.rename ?? rename)(resolved, destination);
  } catch (cause) {
    if (isCode(cause, 'EXDEV')) {
      throw refusalError(
        'input',
        'workspace.scratch-project-other-disk',
        `${parent} is on another disk from the scratch folder, so it was not moved: a folder moves only within one disk, and nothing was copied.`,
        "Choose a folder on the same disk as Brainstrike's data."
      );
    }
    if (isCode(cause, 'EEXIST') || isCode(cause, 'ENOTEMPTY')) {
      throw placeTaken(destination);
    }
    throw cause;
  }
  return destination;
}

export function hostScratchFolders(options: HostScratchFolderOptions): HostScratchFolders {
  return {
    create: async ({ signal, threadId }) => {
      let made: string | undefined;
      try {
        return await options.roots.add({
          make: async () => {
            made = await makeFolder(options, signal);
            return made;
          },
          signal,
          threadId,
        });
      } catch (cause) {
        // The registry recorded nothing: the folder it was given is no thread's.
        if (made === undefined) {
          throw cause;
        }
        return await undoFolder(options, made, cause);
      }
    },
    pickParentFolder: () => options.pickFolder(),
    read: ({ threadId }) => options.roots.read(threadId),
    retire: async ({ threadId }) => {
      const forgotten = await options.roots.forget(threadId);
      if (forgotten === null) {
        return;
      }
      if (!(await forgetHostWorkspaceTrust(options.store, forgotten.path))) {
        // Someone removed it outside Brainstrike: its records are gone, and nothing is left to move.
        logger.warn('A deleted thread’s scratch folder was already gone', {
          path: forgotten.path,
          threadId,
        });
        return;
      }
      await options.trash(forgotten.path);
    },
    turnIntoProject: ({ parent, threadId }) =>
      options.roots.promote({
        move: (folder) => moveIntoProject(options, folder, parent),
        threadId,
      }),
  };
}
