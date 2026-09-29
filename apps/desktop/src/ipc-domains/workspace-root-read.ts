import path from 'node:path';
import {
  AccessError,
  formatFileSize,
  getFileSizeConfig,
  isFullyQualifiedFileSystemPath,
} from '@brainstrike/file-system';
import { isContained, pathsEqual } from './workspace-root-paths';
import type { SecureWorkspaceRoot } from './workspace-root-types';

/** Native secure-fs reads cap one operation at 16MB. */
const NATIVE_MAX_READ_BYTES = 16 * 1024 * 1024;

export interface MountedWorkspaceRootReadAuthority {
  readonly canonicalPath: string;
  readonly presentationPath: string;
  readonly root: SecureWorkspaceRoot;
  readonly rootId: string;
}

export interface ResolvedWorkspaceRead {
  readonly mounted: MountedWorkspaceRootReadAuthority;
  readonly relativePath: string;
  readonly traversedSymlink: boolean;
}

export function assertNativeAbsoluteReadPath(
  value: unknown,
  label: string
): asserts value is string {
  if (isFullyQualifiedFileSystemPath(value) && path.isAbsolute(value)) {
    return;
  }
  throw new AccessError(
    `${label} must be a non-empty native absolute path.`,
    typeof value === 'string' ? value : '',
    'read'
  );
}

function resolveLexicalRelativePath(
  mounted: MountedWorkspaceRootReadAuthority,
  requestedPath: string
): string {
  if (path.isAbsolute(requestedPath)) {
    const normalized = path.normalize(requestedPath);
    if (isContained(mounted.presentationPath, normalized)) {
      return path.relative(mounted.presentationPath, normalized);
    }
    if (isContained(mounted.canonicalPath, normalized)) {
      return path.relative(mounted.canonicalPath, normalized);
    }
  } else {
    const lexicalTarget = path.resolve(mounted.canonicalPath, requestedPath);
    if (isContained(mounted.canonicalPath, lexicalTarget)) {
      return path.relative(mounted.canonicalPath, lexicalTarget);
    }
  }
  throw new AccessError('Path is outside the selected workspace root.', requestedPath, 'read');
}

export async function resolveReadAgainstMountedRoot(
  requestedPath: string,
  mounted: MountedWorkspaceRootReadAuthority,
  resolveReadPath: (requestedPath: string, canonicalRoot: string) => Promise<string>
): Promise<ResolvedWorkspaceRead> {
  const lexicalRelativePath = resolveLexicalRelativePath(mounted, requestedPath);
  // Realpath authorizes the target, but native I/O retains the lexical relative
  // path so an in-root symlink never becomes readable through canonicalization.
  const canonicalTarget = await resolveReadPath(requestedPath, mounted.canonicalPath);
  if (!isContained(mounted.canonicalPath, canonicalTarget)) {
    throw new AccessError('Path is outside the selected workspace root.', requestedPath, 'read');
  }
  const lexicalAbsoluteTarget = path.normalize(
    path.join(mounted.canonicalPath, lexicalRelativePath)
  );
  return {
    mounted,
    relativePath: lexicalRelativePath || '.',
    traversedSymlink: !pathsEqual(lexicalAbsoluteTarget, canonicalTarget),
  };
}

export async function readResolvedWorkspaceFile(
  requestedPath: string,
  resolved: ResolvedWorkspaceRead
): Promise<string> {
  const { maxFileSize } = getFileSizeConfig();
  if (maxFileSize > NATIVE_MAX_READ_BYTES) {
    throw new AccessError(
      `Configured maxFileSize (${formatFileSize(maxFileSize)}) exceeds the native secure-read cap (${formatFileSize(NATIVE_MAX_READ_BYTES)}).`,
      requestedPath,
      'read'
    );
  }
  const result = await resolved.mounted.root.readFile(resolved.relativePath, maxFileSize);
  if (result.status === 'ok') {
    return result.content.toString('utf8');
  }
  if (result.status === 'oversized') {
    throw new AccessError(
      `File too large (max: ${formatFileSize(maxFileSize)})`,
      requestedPath,
      'read'
    );
  }
  if (result.status === 'not-found') {
    throw new AccessError('ENOENT: File not found', requestedPath, 'read');
  }
  if (resolved.traversedSymlink) {
    throw new AccessError(
      'File is a symbolic link. Links are not followed inside workspace roots.',
      requestedPath,
      'read'
    );
  }
  throw new AccessError('File is not accessible.', requestedPath, 'read');
}
