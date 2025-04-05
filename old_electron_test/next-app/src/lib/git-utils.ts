import type LightningFS from '@isomorphic-git/lightning-fs';

export async function copyDirectoryToLightningFS(
  dirHandle: FileSystemDirectoryHandle,
  fs: LightningFS,
  path: string
): Promise<void> {
  // Create the root directory
  await fs.promises.mkdir(path).catch(() => {});

  // Only copy the .git directory initially
  try {
    const gitDir = await dirHandle.getDirectoryHandle('.git', { create: false });
    await copyGitDirectory(gitDir, fs, `${path}/.git`);
  } catch (error) {
    console.error('Error copying .git directory:', error);
    throw error;
  }
}

async function copyGitDirectory(
  gitDir: FileSystemDirectoryHandle,
  fs: LightningFS,
  gitPath: string
): Promise<void> {
  // Create the .git directory
  await fs.promises.mkdir(gitPath).catch(() => {});

  // Copy all files and directories within .git
  for await (const [name, entry] of gitDir.entries()) {
    const entryPath = `${gitPath}/${name}`;

    if (entry.kind === 'file') {
      const fileHandle = entry as FileSystemFileHandle;
      const file = await fileHandle.getFile();
      const content = await file.arrayBuffer();
      await fs.promises.writeFile(entryPath, new Uint8Array(content));
    } else if (entry.kind === 'directory') {
      const dirHandle = entry as FileSystemDirectoryHandle;
      await copyGitDirectory(dirHandle, fs, entryPath);
    }
  }
}
