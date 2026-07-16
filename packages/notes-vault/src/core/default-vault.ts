import type { VaultDirectoryHandleLike } from './types';
import { writeNoteFile } from './write-note';

/**
 * FACTORY RESET CONTRACT: this OPFS directory name is listed in
 * FALLBACK_OPFS_DIR_NAMES in factory-reset-helpers.ts so a reset wipes the
 * default vault's notes.
 */
export const DEFAULT_VAULT_DIR_NAME = 'brainstrike-notes';

/** Display name for the built-in vault root. */
export const DEFAULT_VAULT_DISPLAY_NAME = 'My Notes';

export const WELCOME_NOTE_NAME = 'Welcome.md';
export const WELCOME_NOTE_CONTENT = `# Welcome to Notes

Your notes live here as plain markdown files — no import, no lock-in.

- Click **Edit** (or create a note with **New Note**) to start writing. Changes save automatically; **⌘S** saves immediately.
- Add any folder of markdown as another vault — Open Folder, or drag it onto this panel.
- Link between notes with relative links like [Welcome](Welcome.md); headings, code fences, tasks, and math all render.

Delete this note whenever you like.
`;

/**
 * Ensures the default vault directory exists, seeding a welcome note only on
 * first creation — a user who deletes the welcome note never sees it again.
 */
export async function ensureDefaultVault(
  storageRoot: VaultDirectoryHandleLike
): Promise<VaultDirectoryHandleLike> {
  try {
    // Existing vault: leave its contents alone.
    return await storageRoot.getDirectoryHandle(DEFAULT_VAULT_DIR_NAME);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
      throw error;
    }
  }
  const created = await storageRoot.getDirectoryHandle(DEFAULT_VAULT_DIR_NAME, { create: true });
  const welcome = await created.getFileHandle(WELCOME_NOTE_NAME, { create: true });
  await writeNoteFile(welcome, WELCOME_NOTE_CONTENT);
  return created;
}
