/**
 * Bounded whole-file text reader for the desktop native tools (BST-743): resolve
 * a workspace path to a contained absolute path, then read it in full as UTF-8
 * with a size cap and a NUL-byte binary probe. Shared by the file-inspection
 * families (LSP symbol/inspect, rename-destination reindex, workspace-context,
 * @file injection) that need a small whole-file read rather than the paged
 * `readWorkspaceFile` tool.
 *
 * Leaf module: depends only on node fs and the shared path-resolution helper —
 * never on `assistant-tools.ts`, so no import cycle is possible.
 */
import fsPromises from 'node:fs/promises';
import { assertNotAgentIgnored } from './agent-ignore-guard';
import { resolveWorkspaceAbsolutePath } from './workspace-path-resolution';

export const MAX_READ_WORKSPACE_FILE_BYTES = 2_000_000;

export async function readWorkspaceTextFile(args: {
  requestedPath: string;
  rootPath: string;
}): Promise<{
  absolutePath: string;
  content: string;
  mtimeMs: number;
  path: string;
  size: number;
}> {
  const resolved = await resolveWorkspaceAbsolutePath(args.rootPath, args.requestedPath);
  // Checked here, at the shared reader, so every consumer inherits it: LSP
  // inspection, rename reindex, workspace-context, and @file injection all read
  // through this one function (BST-1432).
  await assertNotAgentIgnored({
    canonicalAbsolutePath: resolved.absolutePath,
    canonicalRootPath: args.rootPath,
    relativePath: resolved.workspacePath,
  });

  const stat = await fsPromises.stat(resolved.absolutePath);
  if (!stat.isFile()) {
    throw new Error(`Path "${args.requestedPath}" is not a file.`);
  }
  if (stat.size > MAX_READ_WORKSPACE_FILE_BYTES) {
    throw new Error(
      `Path "${args.requestedPath}" exceeds ${MAX_READ_WORKSPACE_FILE_BYTES} bytes and cannot be read in full.`
    );
  }

  const fileBuffer = await fsPromises.readFile(resolved.absolutePath);
  const binaryProbeLength = Math.min(fileBuffer.length, 4096);
  for (let index = 0; index < binaryProbeLength; index += 1) {
    if (fileBuffer[index] === 0) {
      throw new Error(`Path "${args.requestedPath}" is a binary file and cannot be read as text.`);
    }
  }

  return {
    absolutePath: resolved.absolutePath,
    content: fileBuffer.toString('utf8'),
    mtimeMs: stat.mtimeMs,
    path: resolved.workspacePath,
    size: Number(stat.size),
  };
}
