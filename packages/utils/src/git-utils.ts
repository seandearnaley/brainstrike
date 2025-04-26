/**
 * Utility functions for Git operations
 */

// Type declaration for LightningFS for better type safety
interface LightningFS {
  promises: {
    mkdir: (path: string) => Promise<void>;
    writeFile: (path: string, data: Uint8Array) => Promise<void>;
  };
}

// Type declarations for FileSystemDirectoryHandle
interface FileSystemDirectoryHandleWithEntries extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

/**
 * Copies directory content to LightningFS for Git operations
 * @param dirHandle Source directory handle
 * @param fs LightningFS instance
 * @param path Target path in LightningFS
 */
export async function copyDirectoryToLightningFS(
  dirHandle: FileSystemDirectoryHandle,
  fs: LightningFS,
  path: string
): Promise<void> {
  console.log(`[GitUtils] Starting copyDirectoryToLightningFS for path: ${path}`);
  // Create the root directory
  await fs.promises.mkdir(path).catch(() => {});

  // Only copy the .git directory initially
  try {
    console.log('[GitUtils] Attempting to get .git handle from source dir...');
    const gitDir = await dirHandle.getDirectoryHandle('.git', {
      create: false,
    });
    console.log(`[GitUtils] Found .git handle. Starting recursive copy to ${path}/.git`);
    await copyGitDirectory(gitDir as FileSystemDirectoryHandleWithEntries, fs, `${path}/.git`);
    console.log(`[GitUtils] Finished recursive copy for ${path}/.git`);
  } catch (error) {
    // Log the specific error during .git handle access or copy
    console.error(`[GitUtils] Error during copyDirectoryToLightningFS for path ${path}:`, error);
    // Re-throw the error so the caller knows initialization failed
    throw error;
  }
  console.log(`[GitUtils] Successfully finished copyDirectoryToLightningFS for path: ${path}`);
}

/**
 * Recursively copies a Git directory to LightningFS
 * @param sourceDirHandle Source directory handle
 * @param fs LightningFS instance
 * @param targetGitPath Target path in LightningFS
 */
async function copyGitDirectory(
  sourceDirHandle: FileSystemDirectoryHandleWithEntries,
  fs: LightningFS,
  targetGitPath: string
): Promise<void> {
  // Create the target directory in LightningFS
  await fs.promises.mkdir(targetGitPath).catch(() => {});

  // Copy all files and directories within the source .git subdirectory
  try {
    for await (const [name, entry] of sourceDirHandle.entries()) {
      const targetEntryPath = `${targetGitPath}/${name}`;

      if (entry.kind === 'file') {
        const fileHandle = entry as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        const content = await file.arrayBuffer();
        console.log(
          `[GitUtils] Attempting to write file: ${targetEntryPath} (${content.byteLength} bytes)`
        );
        try {
          await fs.promises.writeFile(targetEntryPath, new Uint8Array(content));
        } catch (writeError) {
          console.error(`[GitUtils] FAILED to write file: ${targetEntryPath}`, writeError);
          throw writeError; // Re-throw to ensure failure propagates
        }
      } else if (entry.kind === 'directory') {
        const subDirHandle = entry as FileSystemDirectoryHandleWithEntries;
        await copyGitDirectory(subDirHandle, fs, targetEntryPath);
      }
    }
  } catch (error) {
    // Catch errors during the loop/recursion
    console.error(`[GitUtils] Error during recursive copy within ${targetGitPath}:`, error);
    // Re-throw the error to ensure the caller knows the copy was incomplete
    throw error;
  }
}
