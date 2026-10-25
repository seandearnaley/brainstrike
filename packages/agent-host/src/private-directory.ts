import { chmod, mkdir, stat } from 'node:fs/promises';
import { applyPrivateDirectorySync } from '@brainstrike/secure-fs-native';

/** Creates the host's data root private to this user, or refuses one another user owns. */
export async function secureDirectory(root: string): Promise<void> {
  await mkdir(root, { mode: 0o700, recursive: true });
  if (process.platform === 'win32') {
    // BST-2237: owner and protected DACL written and read back on one handle,
    // in this process. Host start starts no PowerShell.
    applyPrivateDirectorySync(root);
    return;
  }
  const info = await stat(root);
  if (info.uid !== process.getuid?.()) {
    throw new Error(`Host directory belongs to another user: ${root}`);
  }
  await chmod(root, 0o700);
}
