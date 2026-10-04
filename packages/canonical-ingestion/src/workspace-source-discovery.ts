import path from 'node:path';
import { AccessError } from '@brainstrike/file-system';
import { readResolvedWorkspaceFile } from '@brainstrike/file-system/secure-file-read';
import {
  buildDirectoryListing,
  MAX_DIRECTORY_ENTRIES,
} from '@brainstrike/file-system/workspace-root-nodes';
import { discoverWorkspaceFiles } from '@brainstrike/file-system/workspace-scan';
import {
  isUnderRelativePrefix,
  normalizeScopedChangePath,
  toRootRelativePath,
  toTruncatedRelativePrefixes,
} from '@brainstrike/file-system/workspace-scan-paths';
import {
  collectFullScanMissingFileInvalidations,
  collectScopedRemovalInvalidations,
} from '@brainstrike/file-system/workspace-scan-reconciliation';
import type { DirectoryHandle, IFileNode } from '@brainstrike/types';
import type {
  CanonicalDiscoveredSourceFile,
  CanonicalDiscoveryCompletion,
  CanonicalFileIdentity,
  CanonicalOperationContext,
  CanonicalScanRequest,
  CanonicalSourceFile,
} from './ports.js';
import type { CanonicalWorkspaceSourceDependencies } from './workspace-source-ports.js';

export interface WorkspaceSourceDiscovery {
  readonly completion: CanonicalDiscoveryCompletion;
  readonly discovered: readonly CanonicalDiscoveredSourceFile[];
  readonly files: readonly CanonicalSourceFile[];
  readonly nodes: ReadonlyMap<string, IFileNode>;
  readonly removed: readonly CanonicalFileIdentity[];
}

export async function discoverCanonicalWorkspace(
  dependencies: CanonicalWorkspaceSourceDependencies,
  request: CanonicalScanRequest,
  context: CanonicalOperationContext
): Promise<WorkspaceSourceDiscovery> {
  const { lease } = dependencies;
  if (!lease || request.scope.kind !== 'workspace' || request.scope.rootId !== lease.rootId) {
    throw new Error('Workspace source requires the exact authorized mounted lease.');
  }
  const rootHandle: DirectoryHandle = {
    kind: 'directory',
    name: path.basename(lease.canonicalPath),
    path: lease.canonicalPath,
    platform: 'electron',
    rootId: lease.rootId,
  };
  const scope = dependencies.resolveScanScope?.(request) ?? { mode: 'full' };
  const discovery = await discoverWorkspaceFiles({
    abortSignal: context.signal,
    deps: {
      fileSystemAdapter: {
        readDirectory: async (handle) => {
          if (handle.rootId !== lease.rootId) {
            throw new Error('Directory projection belongs to another mounted root.');
          }
          const relativePath = toRootRelativePath(lease.canonicalPath, handle.path) || '.';
          const listing = await lease.listDir(relativePath, MAX_DIRECTORY_ENTRIES, context);
          context.signal.throwIfAborted();
          if (!listing) {
            throw new AccessError('Directory is not accessible.', handle.path, 'read');
          }
          return buildDirectoryListing(lease, handle.path, listing);
        },
        readFile: async (handle) => {
          if (handle.rootId !== lease.rootId) {
            throw new Error('Ignore file projection belongs to another mounted root.');
          }
          const content = await readResolvedWorkspaceFile(
            handle.path,
            {
              mounted: {
                root: {
                  readFile: (relativePath, maxBytes) =>
                    lease.readFile(relativePath, maxBytes, context),
                },
              },
              relativePath: toRootRelativePath(lease.canonicalPath, handle.path),
              traversedSymlink: false,
            },
            request.maxFileBytes
          );
          context.signal.throwIfAborted();
          return content;
        },
      },
    },
    indexingPolicyPreset: dependencies.indexingPolicyPreset,
    onScanningPath: () => {},
    rootHandle,
    rootPath: lease.canonicalPath,
    scope,
  });
  const effectiveScope = discovery.scope;
  const inventory = await dependencies.inventory.loadFiles(request.scope, context);
  context.signal.throwIfAborted();
  const byPath = new Map<string, CanonicalSourceFile>();
  const fileIds = new Set<string>();
  for (const file of inventory) {
    if (
      file.rootId !== lease.rootId ||
      !file.relativePath ||
      byPath.has(file.relativePath) ||
      fileIds.has(file.fileId)
    ) {
      throw new Error('Workspace inventory has foreign or repeated canonical identities.');
    }
    byPath.set(file.relativePath, file);
    fileIds.add(file.fileId);
  }
  const nodes = new Map<string, IFileNode>();
  const files: CanonicalSourceFile[] = [];
  const discovered: CanonicalDiscoveredSourceFile[] = [];
  for (const node of discovery.fileNodes) {
    const relativePath = toRootRelativePath(lease.canonicalPath, node.path);
    if (nodes.has(relativePath)) {
      throw new Error('Workspace discovery repeated a path.');
    }
    nodes.set(relativePath, node);
    const stat = { mtimeMs: node.lastModified ?? null, size: node.size ?? 0 };
    const registered = byPath.get(relativePath);
    if (registered) {
      files.push({ ...registered, stat });
      continue;
    }
    discovered.push({
      fileName: node.name,
      relativePath,
      rootId: lease.rootId,
      sourcePath: node.path,
      stat,
    });
  }
  const entries = inventory.map((file) => ({
    fileRecordId: file.fileId,
    relativePath: file.relativePath ?? '',
    rootId: lease.rootId,
  }));
  const truncatedDirectoryPrefixes = toTruncatedRelativePrefixes(
    discovery.truncatedDirectoryPaths,
    lease.canonicalPath
  );
  const targets =
    effectiveScope.mode === 'full'
      ? collectFullScanMissingFileInvalidations({
          existingEntries: entries,
          fileNodes: discovery.fileNodes,
          rootId: lease.rootId,
          rootPath: lease.canonicalPath,
          truncatedDirectoryPrefixes,
        })
      : collectScopedRemovalInvalidations({
          existingEntries: entries,
          liveFilePaths: new Set(
            discovery.fileNodes.map((node) =>
              normalizeScopedChangePath(
                { kind: 'file', path: node.path, type: 'modified' },
                lease.canonicalPath
              )
            )
          ),
          pendingRemovals: discovery.pendingRemovals,
          rootId: lease.rootId,
          truncatedDirectoryPrefixes,
        });
  const removed = inventory.filter((file) =>
    targets.some((target) =>
      target.mode === 'prefix'
        ? isUnderRelativePrefix(file.relativePath ?? '', target.relativePathPrefix)
        : file.relativePath === target.relativePath &&
          (target.expectedFileRecordId === undefined || target.expectedFileRecordId === file.fileId)
    )
  );
  return {
    completion: {
      errors: [...discovery.fileHandleResolutionFailurePaths],
      full: effectiveScope.mode === 'full',
      truncatedDirectories: [...discovery.truncatedDirectoryPaths],
    },
    discovered,
    files,
    nodes,
    removed,
  };
}
