import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { refusalError } from '@brainstrike/assistant-contract';

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
