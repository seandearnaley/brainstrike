import type { VaultFileHandleLike } from './types';

/**
 * Atomically replaces a note's content: createWritable() buffers into a swap
 * file and only replaces the real file on close(), so a crash mid-save can
 * never corrupt the note. Failures propagate — the caller surfaces them.
 */
export async function writeNoteFile(handle: VaultFileHandleLike, content: string): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}
