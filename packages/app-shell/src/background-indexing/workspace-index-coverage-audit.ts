import {
  createFileContentProcessor,
  type FileContentProcessor,
  type FileContentRequest,
} from '@brainstrike/file-explorer-hooks';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { normalizeSelectionPathForFolder } from '@brainstrike/utils/relative-file-path';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { getContentIndexingError } from './workspace-collection-sync-import';

/**
 * The idle coverage audit compares the on-disk expected file set against the
 * indexed `file_records` rows. A raw count comparison is NOT sufficient: the
 * scan-side expected count is built from the name/size entry policy, while the
 * import pipeline additionally refuses files at CONTENT level (null bytes,
 * binary content behind a text extension, unreadable, too large at read time).
 * Those files can never be indexed, so they must not be reported as missing
 * coverage — that false mismatch made every audit demand a recovery sync that
 * could never converge. This module resolves the ACTUAL missing paths and
 * re-applies the import content gate to them, so only genuinely missed files
 * (readable, indexable, but absent from the index) count against coverage.
 */

/** Upper bound on audit-time content reads. The audit runs at idle and reads
 * ONLY the missing files; a gap larger than this is a genuine coverage hole
 * regardless of content, so the remainder is honestly reported unclassified
 * instead of read. */
export const WORKSPACE_COVERAGE_MAX_CLASSIFICATION_READS = 200;
const CLASSIFICATION_READ_CONCURRENCY = 2;

export interface WorkspaceCoverageExpectedFile {
  readonly node: IFileNode;
  readonly relativePath: string;
}

export interface WorkspaceCoverageGapClassification {
  /** Missing files whose content the import gate refuses — legitimately
   * unindexable, counted as covered. Reason is the import gate's own marker. */
  contentExcluded: Array<{ reason: string; relativePath: string }>;
  /** Missing files that are readable and indexable — real coverage gaps. */
  genuinelyMissing: string[];
  /** Missing files beyond the read budget that were not classified. */
  unclassifiedCount: number;
}

export function buildWorkspaceCoverageExpectedFiles(args: {
  fileNodes: readonly IFileNode[];
  rootPath: string;
}): WorkspaceCoverageExpectedFile[] {
  const byRelativePath = new Map<string, WorkspaceCoverageExpectedFile>();
  for (const node of args.fileNodes) {
    const relativePath = normalizeSelectionPathForFolder(node.path, args.rootPath, {
      label: 'Workspace Index coverage file path',
    });
    byRelativePath.set(relativePath, { node, relativePath });
  }
  return [...byRelativePath.values()];
}

export function resolveMissingCoverageFiles(args: {
  expectedFiles: readonly WorkspaceCoverageExpectedFile[];
  indexedRelativePaths: ReadonlySet<string>;
}): WorkspaceCoverageExpectedFile[] {
  return args.expectedFiles.filter((file) => !args.indexedRelativePaths.has(file.relativePath));
}

export async function classifyMissingCoverageFiles(args: {
  fileContentProcessor?: Pick<FileContentProcessor, 'processFiles'>;
  fileSystemAdapter: FileSystemAdapter;
  maxContentReads?: number;
  missingFiles: readonly WorkspaceCoverageExpectedFile[];
  rootPath: string;
}): Promise<WorkspaceCoverageGapClassification> {
  const maxContentReads = args.maxContentReads ?? WORKSPACE_COVERAGE_MAX_CLASSIFICATION_READS;
  const filesToRead = args.missingFiles.slice(0, maxContentReads);
  const unclassifiedCount = args.missingFiles.length - filesToRead.length;
  if (filesToRead.length === 0) {
    return { contentExcluded: [], genuinelyMissing: [], unclassifiedCount };
  }

  const processor =
    args.fileContentProcessor ??
    createFileContentProcessor(args.fileSystemAdapter, {
      concurrency: CLASSIFICATION_READ_CONCURRENCY,
    });
  const requests: FileContentRequest[] = filesToRead.map((file) => ({
    compositeKey: encodeFileSelection(args.rootPath, file.relativePath),
    fileNode: file.node,
    fileSystemAdapter: args.fileSystemAdapter,
  }));
  const contents = await processor.processFiles(requests);

  const contentExcluded: Array<{ reason: string; relativePath: string }> = [];
  const genuinelyMissing: string[] = [];
  for (const [index, file] of filesToRead.entries()) {
    const request = requests[index];
    const content = request ? contents[request.compositeKey] : undefined;
    if (content === undefined) {
      // The reader returned nothing for this file: coverage cannot be proven
      // unnecessary, so fail toward recovery rather than toward silence.
      genuinelyMissing.push(file.relativePath);
      continue;
    }
    const reason = getContentIndexingError(content);
    if (reason) {
      contentExcluded.push({ reason, relativePath: file.relativePath });
      continue;
    }
    genuinelyMissing.push(file.relativePath);
  }
  return { contentExcluded, genuinelyMissing, unclassifiedCount };
}

function readIndexedPathRow(row: unknown): { path: string; rootId: string } | null {
  if (!(row && typeof row === 'object')) {
    return null;
  }
  const record = row as Record<string, unknown>;
  const rootId = record['root_id'] ?? record['rootId'];
  const path = record['path'] ?? record['relativePath'];
  if (typeof rootId !== 'string' || rootId.length === 0 || typeof path !== 'string') {
    return null;
  }
  return { path, rootId };
}

export async function readIndexedRelativePathsByRoot(args: {
  collectionId: string;
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows?: unknown[] }> };
  rootIds: readonly string[];
}): Promise<Map<string, Set<string>>> {
  const indexedPaths = new Map<string, Set<string>>();
  if (args.rootIds.length === 0) {
    return indexedPaths;
  }
  const rootPlaceholders = args.rootIds.map((_, index) => `$${index + 2}`).join(', ');
  const result = await args.db.query(
    `
      SELECT root_id, path
      FROM file_records
      WHERE embedding_set_id = $1
        AND root_id IN (${rootPlaceholders})
    `,
    [args.collectionId, ...args.rootIds]
  );
  for (const row of Array.isArray(result.rows) ? result.rows : []) {
    const parsed = readIndexedPathRow(row);
    if (!parsed) {
      continue;
    }
    const existing = indexedPaths.get(parsed.rootId);
    if (existing) {
      existing.add(parsed.path);
      continue;
    }
    indexedPaths.set(parsed.rootId, new Set([parsed.path]));
  }
  return indexedPaths;
}
