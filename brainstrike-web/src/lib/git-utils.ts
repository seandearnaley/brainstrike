import type LightningFS from '@isomorphic-git/lightning-fs';

export async function copyDirectoryToLightningFS(
  dirHandle: FileSystemDirectoryHandle,
  fs: LightningFS,
  path: string
): Promise<void> {
  console.log(`[GitUtils] Starting copyDirectoryToLightningFS for path: ${path}`); // Reverted to template literal
  // Create the root directory
  await fs.promises.mkdir(path).catch(() => {});

  // Only copy the .git directory initially
  try {
    console.log('[GitUtils] Attempting to get .git handle from source dir...');
    const gitDir = await dirHandle.getDirectoryHandle('.git', { create: false });
    console.log(`[GitUtils] Found .git handle. Starting recursive copy to ${path}/.git`); // Reverted to template literal
    await copyGitDirectory(gitDir, fs, `${path}/.git`);
    console.log(`[GitUtils] Finished recursive copy for ${path}/.git`); // Reverted to template literal
  } catch (error) {
    // Log the specific error during .git handle access or copy
    console.error(`[GitUtils] Error during copyDirectoryToLightningFS for path ${path}:`, error); // Reverted to template literal
    // Re-throw the error so the caller knows initialization failed
    throw error;
  }
  console.log(`[GitUtils] Successfully finished copyDirectoryToLightningFS for path: ${path}`); // Reverted to template literal
}

async function copyGitDirectory(
  sourceDirHandle: FileSystemDirectoryHandle, // Renamed for clarity
  fs: LightningFS,
  targetGitPath: string // Renamed for clarity
): Promise<void> {
  // console.log(`[GitUtils] Entering copyGitDirectory for target: ${targetGitPath}`); // Verbose entry log (optional)
  // Create the target directory in LightningFS
  await fs.promises.mkdir(targetGitPath).catch(() => {});

  // Copy all files and directories within the source .git subdirectory
  try {
    for await (const [name, entry] of sourceDirHandle.entries()) {
      const targetEntryPath = `${targetGitPath}/${name}`;

      // console.log(`[GitUtils] Processing entry: ${name} (Kind: ${entry.kind}) -> ${targetEntryPath}`); // Verbose processing log (optional)

      if (entry.kind === 'file') {
        const fileHandle = entry as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        const content = await file.arrayBuffer();
        console.log(
          `[GitUtils] Attempting to write file: ${targetEntryPath} (${content.byteLength} bytes)`
        ); // Log before write
        try {
          await fs.promises.writeFile(targetEntryPath, new Uint8Array(content));
          // console.log(`[GitUtils] Successfully wrote file: ${targetEntryPath}`); // Optional success log (can be noisy)
        } catch (writeError) {
          console.error(`[GitUtils] FAILED to write file: ${targetEntryPath}`, writeError); // Log write error specifically
          throw writeError; // Re-throw to ensure failure propagates
        }
      } else if (entry.kind === 'directory') {
        const subDirHandle = entry as FileSystemDirectoryHandle;
        // console.log(`[GitUtils] Recursing into directory: ${name}`); // Verbose recursion log (optional)
        await copyGitDirectory(subDirHandle, fs, targetEntryPath);
        // console.log(`[GitUtils] Finished recursion for directory: ${name}`); // Verbose recursion finish log (optional)
      }
    }
    // console.log(`[GitUtils] Finished processing entries for target: ${targetGitPath}`); // Verbose loop finish log (optional)
  } catch (error) {
    // Catch errors during the loop/recursion
    console.error(`[GitUtils] Error during recursive copy within ${targetGitPath}:`, error);
    // Re-throw the error to ensure the caller knows the copy was incomplete
    throw error;
  }
}
