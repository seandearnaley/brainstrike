import type LightningFS from '@isomorphic-git/lightning-fs';

export async function copyDirectoryToLightningFS(
  dirHandle: FileSystemDirectoryHandle,
  fs: LightningFS,
  path: string
): Promise<void> {
  console.log(`[GitUtils] Starting copyDirectoryToLightningFS for path: ${path}`);
  try {
    await fs.promises.mkdir(path);
    console.log(`[GitUtils] Created root directory: ${path}`);
  } catch (mkdirError) {
    // Ignore if directory already exists, log other errors
    // @ts-expect-error - code may not exist on all errors
    if (mkdirError?.code !== 'EEXIST') {
      console.error(`[GitUtils] FAILED to create root directory ${path}`, mkdirError);
      throw mkdirError; // Propagate critical error
    } else {
      console.log(`[GitUtils] Root directory ${path} already exists.`);
    }
  }

  // Only copy the .git directory initially
  try {
    console.log('[GitUtils] Attempting to get .git handle from source dir...');
    const gitDir = await dirHandle.getDirectoryHandle('.git', {
      create: false,
    });

    console.log(`[GitUtils] Found .git handle. Starting recursive copy to ${path}/.git`);
    await copyGitDirectory(fs, gitDir, `${path}/.git`);
    console.log(`[GitUtils] Finished recursive copy for ${path}/.git`);
  } catch (error) {
    // Log the specific error during .git handle access or copy
    console.error(`[GitUtils] Error during .git directory processing for path ${path}:`, error);
    // Re-throw the error so the caller knows initialization failed
    throw error;
  }
  console.log(`[GitUtils] Successfully finished copyDirectoryToLightningFS for path: ${path}`);
}

/**
 * Recursively copies a directory from a FileSystemDirectoryHandle to a LightningFS.
 * 
 * @param fs The LightningFS instance to write to.
 * @param sourceDirHandle The source directory handle to read from.
 * @param targetPath The path in the LightningFS where the directory should be copied.
 */
export async function copyGitDirectory(
  fs: LightningFS,
  sourceDirHandle: FileSystemDirectoryHandle,
  targetPath: string,
): Promise<void> {
  try {
    // Ensure the target directory exists in LightningFS
    try {
      await fs.promises.mkdir(targetPath);
    } catch (e) {
      // Ignore error if directory already exists
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw e;
      }
    }

    const promises: Promise<void>[] = []; // Array to hold all promises

    for await (const [name, handle] of sourceDirHandle.entries()) {
      const entryPath = `${targetPath}/${name}`;

      if (handle.kind === 'file') {
        const fileHandle = handle as FileSystemFileHandle; // Assert type
        // Add the promise for writing the file to the array
        promises.push(
          (async () => {
            try {
              const file = await fileHandle.getFile();
              const buffer = await file.arrayBuffer();
              await fs.promises.writeFile(entryPath, new Uint8Array(buffer));
              // console.debug(`[GitUtils] Copied file: ${entryPath}`);
            } catch (writeError) {
              console.error(`[GitUtils] Error writing file ${entryPath}:`, writeError);
              throw writeError; // Re-throw to fail the Promise.all
            }
          })()
        );
      } else if (handle.kind === 'directory') {
        const dirHandle = handle as FileSystemDirectoryHandle; // Assert type
        // Add the promise for the recursive call to the array
        promises.push(copyGitDirectory(fs, dirHandle, entryPath));
      }
    }

    // Wait for all file writes and recursive calls at this level to complete
    await Promise.all(promises);

    // Log only when the root .git directory copy finishes, if desired
    // if (isRootGitDir) {
    //   console.log(`[GitUtils] Finished recursive copy for ${targetPath}`);
    // }
  } catch (error) {
    console.error(`[GitUtils] Error copying directory ${targetPath}:`, error);
    throw error; // Propagate the error
  }
}
