import type { Dirent } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { refusalError } from '@brainstrike/assistant-contract';
import type { ScratchFolderRetained, ScratchFolderTrash } from '@brainstrike/types';

const notScratch = (folder: string) =>
  refusalError(
    'authorization',
    'workspace.scratch-outside',
    `${folder} is not a scratch folder, so it was not moved to the Trash.`
  );

/** The canonical path of `target`, or undefined when nothing is there. */
async function canonical(target: string): Promise<string | undefined> {
  try {
    return path.normalize(await realpath(target));
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
      return;
    }
    throw cause;
  }
}

/**
 * ADR-0034 scratch threads: Main moves a deleted thread's scratch folder to the
 * system Trash for the agent host, which runs where Electron's shell is not.
 * Only a folder directly inside `<userData>/scratch` is moved, the one place
 * the host makes them, so no other path reaches the Trash this way. Both are
 * compared at their canonical paths, as the host makes and records the folder.
 */
export async function trashScratchFolder(
  userDataPath: string,
  folder: string,
  trash: (folder: string) => Promise<void>
): Promise<void> {
  if (!path.isAbsolute(folder)) {
    throw notScratch(folder);
  }
  const [directory, resolved] = await Promise.all([
    canonical(path.join(userDataPath, 'scratch')),
    canonical(folder),
  ]);
  if (directory === undefined || resolved === undefined || path.dirname(resolved) !== directory) {
    throw notScratch(folder);
  }
  try {
    await trash(resolved);
  } catch (cause) {
    // The system's reason, so the person reads why the folder stayed (a volume with no Trash).
    throw refusalError(
      'availability',
      'workspace.trash-failed',
      `${resolved} was not moved to the Trash: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
}

/**
 * ADR-0015, ADR-0034: Clear Database deletes every scratch thread's row, so once the clear has
 * succeeded Main moves every folder directly inside `<userData>/scratch` to the system Trash,
 * each through `trashScratchFolder`'s guard. A file or a link there is left alone; a folder the
 * Trash refuses is named with why and never stops the next. No `scratch` folder is nothing to
 * move; one that cannot be read throws, for the clear's outcome to name.
 */
export async function trashEveryScratchFolder(
  userDataPath: string,
  trash: (folder: string) => Promise<void>
): Promise<ScratchFolderTrash> {
  const directory = path.join(userDataPath, 'scratch');
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
      return { retained: [], trashed: [] };
    }
    throw cause;
  }
  const retained: ScratchFolderRetained[] = [];
  const trashed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const folder = path.join(directory, entry.name);
    try {
      await trashScratchFolder(userDataPath, folder, trash);
      trashed.push(folder);
    } catch (cause) {
      retained.push({
        path: folder,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return { retained, trashed };
}
