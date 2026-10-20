import { verifyPrivateDirectorySync } from '@brainstrike/secure-fs-native';

/**
 * BST-2237: whether a Windows host directory is private to its user, read by
 * secure-fs-native from one directory handle in this process: no process
 * starts. Throws when another principal owns it, or its DACL is anything but
 * the protected one-ACE grant `applyPrivateDirectorySync` writes. A failed read
 * keeps its typed native error.
 */
export function verifyWindowsPrivateDirectory(path: string): void {
  const { status } = verifyPrivateDirectorySync(path);
  if (status !== 'private') {
    throw new Error(
      status === 'foreign-owner'
        ? 'Host metadata belongs to another user'
        : 'Host metadata Windows ACL must grant only its current user full control'
    );
  }
}
