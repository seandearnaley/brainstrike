import type { VaultDirectoryHandleLike } from './types';

const MAX_NAME_ATTEMPTS = 1000;

async function nameIsFree(dir: VaultDirectoryHandleLike, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return false;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return true;
    }
    throw error;
  }
}

export interface CreateVaultNoteOptions {
  title?: string;
}

export interface CreatedVaultNote {
  readonly name: string;
}

/**
 * Creates a new markdown note with a unique name ("Title.md", "Title 2.md",
 * ...). The write is atomic: createWritable() buffers into a swap file and
 * only replaces the real file on close(), so a crash cannot leave a
 * half-written note.
 */
export async function createVaultNote(
  dir: VaultDirectoryHandleLike,
  options: CreateVaultNoteOptions = {}
): Promise<CreatedVaultNote> {
  const title = options.title?.trim() || 'Untitled';
  let name = `${title}.md`;
  for (let attempt = 2; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    if (await nameIsFree(dir, name)) {
      break;
    }
    name = `${title} ${attempt}.md`;
  }
  if (!(await nameIsFree(dir, name))) {
    throw new Error(`Could not find a free note name for "${title}"`);
  }

  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(`# ${title}\n\n`);
  await writable.close();
  return { name };
}
