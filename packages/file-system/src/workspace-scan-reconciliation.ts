import type { IFileNode } from '@brainstrike/types';
import { normalizeSelectionPathForFolder } from '@brainstrike/utils/relative-file-path';
import type { ScopedPendingRemoval } from './workspace-scan-nodes.js';
import { isUnderRelativePrefix, isUnderTruncatedDirectory } from './workspace-scan-paths.js';

// Structural scan projections, not canonical catalog identities or authority.
interface ScanEntry {
  readonly fileRecordId: string;
  readonly relativePath: string;
  readonly rootId: string;
}
type ScanInvalidation =
  | { expectedFileRecordId?: string; mode: 'exact'; relativePath: string; rootId: string }
  | { mode: 'prefix'; relativePathPrefix: string; rootId: string };

export function collectFullScanMissingFileInvalidations<Entry extends ScanEntry>(args: {
  existingEntries: readonly Entry[];
  fileNodes: readonly IFileNode[];
  rootId: string;
  rootPath: string;
  truncatedDirectoryPrefixes: readonly string[];
}): ScanInvalidation[] {
  const scannedRelativePaths = new Set(
    args.fileNodes.map((node) =>
      normalizeSelectionPathForFolder(node.path, args.rootPath, {
        label: 'Background cache file path',
      })
    )
  );
  return args.existingEntries.flatMap((entry) => {
    if (entry.rootId !== args.rootId || scannedRelativePaths.has(entry.relativePath)) {
      return [];
    }
    // A truncated listing makes "absent from the scanned tree" unreliable:
    // rows past the cap are omitted, not deleted. Retain them (stale rows are
    // recoverable; deleting live rows is not).
    if (isUnderTruncatedDirectory(entry.relativePath, args.truncatedDirectoryPrefixes)) {
      return [];
    }
    return [
      {
        expectedFileRecordId: entry.fileRecordId,
        mode: 'exact',
        relativePath: entry.relativePath,
        rootId: args.rootId,
      } satisfies ScanInvalidation,
    ];
  });
}

function makeInvalidationTargetKey(target: ScanInvalidation): string {
  if (target.mode === 'prefix') {
    return `prefix:${target.rootId}:${target.relativePathPrefix}`;
  }
  return `exact:${target.rootId}:${target.relativePath}:${target.expectedFileRecordId ?? ''}`;
}

function dedupeInvalidationTargets(targets: readonly ScanInvalidation[]): ScanInvalidation[] {
  const byKey = new Map<string, ScanInvalidation>();
  for (const target of targets) {
    byKey.set(makeInvalidationTargetKey(target), target);
  }
  return [...byKey.values()];
}

function collectRemovedDirectoryEntryTargets(args: {
  existingEntries: readonly ScanEntry[];
  liveFilePaths: ReadonlySet<string>;
  removalRelativePath: string;
  rootId: string;
  truncatedDirectoryPrefixes: readonly string[];
}): ScanInvalidation[] {
  const targets: ScanInvalidation[] = [];
  for (const entry of args.existingEntries) {
    if (
      entry.rootId !== args.rootId ||
      !isUnderRelativePrefix(entry.relativePath, args.removalRelativePath) ||
      args.liveFilePaths.has(entry.relativePath) ||
      isUnderTruncatedDirectory(entry.relativePath, args.truncatedDirectoryPrefixes)
    ) {
      continue;
    }
    targets.push({
      expectedFileRecordId: entry.fileRecordId,
      mode: 'exact',
      relativePath: entry.relativePath,
      rootId: args.rootId,
    });
  }
  return targets;
}

export function collectScopedRemovalInvalidations<Entry extends ScanEntry>(args: {
  existingEntries: readonly Entry[];
  liveFilePaths: ReadonlySet<string>;
  pendingRemovals: readonly ScopedPendingRemoval[];
  rootId: string;
  truncatedDirectoryPrefixes: readonly string[];
}): ScanInvalidation[] {
  const targets: ScanInvalidation[] = [];
  for (const removal of args.pendingRemovals) {
    if (removal.change.kind === 'file') {
      // Watcher-authoritative exact removal: recreation in the same batch is
      // re-resolved with a synthetic-node fallback, so truncation cannot hide
      // a live recreated file from this branch.
      if (args.liveFilePaths.has(removal.relativePath)) {
        continue;
      }
      targets.push({
        mode: 'exact',
        relativePath: removal.relativePath,
        rootId: args.rootId,
      });
      continue;
    }

    // Directory removals infer deletions from the re-listed live set; a
    // truncated listing anywhere over this subtree makes that set incomplete,
    // so absence-based invalidation must not run against it.
    if (isUnderTruncatedDirectory(removal.relativePath, args.truncatedDirectoryPrefixes)) {
      continue;
    }

    let foundLiveDescendant = false;
    for (const liveFilePath of args.liveFilePaths) {
      if (isUnderRelativePrefix(liveFilePath, removal.relativePath)) {
        foundLiveDescendant = true;
        break;
      }
    }
    if (!foundLiveDescendant) {
      targets.push({
        mode: 'prefix',
        relativePathPrefix: removal.relativePath,
        rootId: args.rootId,
      });
      continue;
    }

    targets.push(
      ...collectRemovedDirectoryEntryTargets({
        existingEntries: args.existingEntries,
        liveFilePaths: args.liveFilePaths,
        removalRelativePath: removal.relativePath,
        rootId: args.rootId,
        truncatedDirectoryPrefixes: args.truncatedDirectoryPrefixes,
      })
    );
  }
  return dedupeInvalidationTargets(targets);
}
