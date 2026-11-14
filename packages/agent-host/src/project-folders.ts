/**
 * ADR-0034 build decisions (BST-2513): the folder New project folder… makes for a thread that
 * works with no folder of its own, inside the folder the person chose with Main's picker.
 *
 * - It is named by the thread's title, slugged (lowercase letters and digits, words joined by
 *   `-`, at most 64 characters), or, for a thread with no title or one that leaves no letters or
 *   digits, as a scratch folder is (`generateWorktreeName`), avoiding the names already there.
 * - Its leaf is made alone, never with its parents, so it is always a folder that did not exist:
 *   a place already taken is refused, as Turn into a project… refuses one, and nothing is made.
 *   A parent among the scratch folders is refused too: Clear Database moves every folder there to
 *   the Trash.
 * - The platform's root registry then opens it as a folder of the person's, with a project of its
 *   own, as one they choose in the picker. A folder the registry did not open is removed again.
 * - Its trust is not written: the person placed it, so it is asked there as for any folder they
 *   open. Only a folder the app places itself (a scratch folder) is trusted by being made.
 */
import { mkdir, readdir, realpath, rmdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { refusalError } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { HostScratchFolder } from './ports.ts';
import type { HostScratchFolderOptions } from './scratch-folders.ts';

const logger = createLogger('HostProjectFolders');

/** The longest name a title gives a folder. */
const NAME_LENGTH = 64;

const isCode = (cause: unknown, code: string): boolean =>
  cause instanceof Error && 'code' in cause && cause.code === code;

/** A title as a folder name: lowercase letters and digits, words joined by `-`; empty when none. */
export function projectFolderName(title: string): string {
  const words = title
    .normalize('NFKD')
    .replaceAll(/\p{M}+/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replace(/^-+/u, '');
  return words.slice(0, NAME_LENGTH).replace(/-+$/u, '');
}

const parentMissing = (parent: string) =>
  refusalError(
    'input',
    'workspace.folder-parent-missing',
    `${parent} is no longer there, so no project folder was made in it.`
  );

/** The canonical path of the folder the person chose, refused when it is gone. */
async function chosenParent(parent: string): Promise<string> {
  try {
    return await realpath(parent);
  } catch (cause) {
    if (isCode(cause, 'ENOENT')) {
      throw parentMissing(parent);
    }
    throw cause;
  }
}

/** Refuses a parent at or inside the scratch directory, both compared at their canonical paths. */
async function refuseInsideScratch(directory: string, chosen: string, parent: string) {
  let scratch: string;
  try {
    scratch = await realpath(directory);
  } catch (cause) {
    // No scratch folder was ever made: nothing can be inside the directory.
    if (isCode(cause, 'ENOENT')) {
      return;
    }
    throw cause;
  }
  if (chosen === scratch || chosen.startsWith(`${scratch}${sep}`)) {
    throw refusalError(
      'input',
      'workspace.folder-inside-scratch',
      `${parent} is among Brainstrike's scratch folders, so no project folder was made there.`,
      'Choose a folder of your own.'
    );
  }
}

/** Makes the folder named for `title` inside `parent`; its path. Refuses a place already taken. */
async function makeFolder(
  options: Pick<HostScratchFolderOptions, 'directory' | 'name'>,
  parent: string,
  title: string | undefined
): Promise<string> {
  const chosen = await chosenParent(parent);
  await refuseInsideScratch(options.directory, chosen, parent);
  const name =
    (title === undefined ? '' : projectFolderName(title)) ||
    options.name(new Set(await readdir(chosen)));
  const folder = join(parent, name);
  try {
    await mkdir(folder);
  } catch (cause) {
    if (isCode(cause, 'EEXIST')) {
      throw refusalError(
        'conflict',
        'workspace.folder-exists',
        `${folder} already exists, so no project folder was made there.`,
        'Choose another folder, or move or rename what is there.'
      );
    }
    if (isCode(cause, 'ENOENT')) {
      throw parentMissing(parent);
    }
    if (['EACCES', 'EPERM', 'EROFS'].some((code) => isCode(cause, code))) {
      throw refusalError(
        'authorization',
        'workspace.folder-not-writable',
        `A folder cannot be made in ${parent}, so no project folder was made there.`,
        'Choose a folder you can write to.'
      );
    }
    throw cause;
  }
  return folder;
}

/** `HostScratchFolders.newProjectFolder`: see the module's note. */
export async function makeHostProjectFolder(
  options: Pick<HostScratchFolderOptions, 'directory' | 'name' | 'roots'>,
  request: { readonly parent: string; readonly title: string | undefined }
): Promise<HostScratchFolder> {
  const folder = await makeFolder(options, request.parent, request.title);
  // Said before the registry opens it, so a host that stops meanwhile leaves a trace of where.
  logger.info('Made a new project folder', { folder });
  try {
    return await options.roots.open(folder);
  } catch (cause) {
    try {
      // Nothing has written to it yet: an empty folder is removed, and anything else is an error.
      await rmdir(folder);
    } catch (cleanup) {
      throw new AggregateError(
        [cause, cleanup],
        `The new project folder ${folder} was not opened, and could not be removed`
      );
    }
    throw cause;
  }
}
