import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { AccessError } from '@brainstrike/file-system';
import {
  type PathValidationErrorCode,
  resolveValidatedPath,
} from '@brainstrike/file-system/path-validation';
import type { SecureWorkspaceRoot } from './workspace-root-types.js';

class WorkspaceReadPathValidationError extends AccessError {
  readonly readDenialCategory = 'path-validation' as const;

  constructor(
    message: string,
    requestedPath: string,
    readonly readDenialCode: PathValidationErrorCode
  ) {
    super(message, requestedPath, 'read');
  }
}

/**
 * Production seam for opening a root capability. The native addon is imported
 * lazily so tests that inject `createSecureRoot` never load it.
 */
export async function createNativeSecureRoot(rootPath: string): Promise<SecureWorkspaceRoot> {
  const { SecureRoot } = await import('@brainstrike/secure-fs-native');
  const root = new SecureRoot(rootPath);
  return {
    canonicalPath: root.canonicalPath,
    close: () => root.close(),
    listDir: (relativePath, maxEntries) => root.listDirAsync(relativePath, maxEntries),
    readFile: (relativePath, maxBytes) => root.readFileAsync(relativePath, maxBytes),
  };
}

export async function resolveCanonicalRootPath(rootPath: string): Promise<string> {
  return path.normalize(await realpath(rootPath));
}

/** Realpath preflight: no traversal, no sensitive directories, no missing targets. */
export async function resolveValidatedReadPath(
  requestedPath: string,
  canonicalRoot: string
): Promise<string> {
  const result = await resolveValidatedPath({
    allowMissing: false,
    blockSensitiveDirectories: true,
    maxTraversal: 0,
    requestedPath,
    rootDir: canonicalRoot,
  });
  if (!result.ok) {
    throw new WorkspaceReadPathValidationError(
      `Path validation failed: ${result.error.message}`,
      requestedPath,
      result.error.code
    );
  }
  return path.normalize(result.path);
}
