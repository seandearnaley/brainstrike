import type { VaultDirectoryHandleLike, VaultFileHandleLike } from './types';

export async function getDirectoryHandleAt(
  root: VaultDirectoryHandleLike,
  segments: readonly string[]
): Promise<VaultDirectoryHandleLike> {
  let current = root;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment);
  }
  return current;
}

export async function getFileHandleAt(
  root: VaultDirectoryHandleLike,
  segments: readonly string[]
): Promise<VaultFileHandleLike> {
  const fileName = segments.at(-1);
  if (fileName === undefined) {
    throw new Error('Cannot resolve a file from empty path segments');
  }
  const dir = await getDirectoryHandleAt(root, segments.slice(0, -1));
  return dir.getFileHandle(fileName);
}
