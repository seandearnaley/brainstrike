import path from 'node:path';
import { AccessError, isFullyQualifiedFileSystemPath } from '@brainstrike/file-system';
import { isContained, pathsEqual } from './workspace-root-paths';
import type { SecureWorkspaceRoot } from './workspace-root-types';

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

export { readResolvedWorkspaceFile } from '@brainstrike/file-system/secure-file-read';
