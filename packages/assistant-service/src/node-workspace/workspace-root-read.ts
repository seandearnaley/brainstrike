import path from 'node:path';
import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import { isFullyQualifiedFileSystemPath } from '@brainstrike/file-system';
import { isContained, pathsEqual } from './workspace-root-paths.js';
import type { SecureWorkspaceRoot } from './workspace-root-types.js';

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
  throw refusalError(
    'input',
    'workspace.path-invalid',
    `${label} must be a non-empty native absolute path.`,
    'Choose a file inside a connected folder.'
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
  throw refusalError(
    'authorization',
    'workspace.path-outside-root',
    'Path is outside the selected workspace root.',
    'Choose a file inside the selected folder.'
  );
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
    throw refusalError(
      'authorization',
      'workspace.path-outside-root',
      'Path is outside the selected workspace root.',
      'Choose a file inside the selected folder.'
    );
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
