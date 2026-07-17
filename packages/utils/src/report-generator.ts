import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { readFullFileTree } from './file-system-utils';
import { decodeFileSelection } from './selection-utils';
import { generateProjectTreeText } from './tree-generator';

const logger = createLogger('ContextGenerator');
const IGNORED_PATTERNS = [
  'node_modules',
  '.git',
  '.DS_Store',
  'dist',
  'build',
  '.turbo',
  'coverage',
  '.nyc_output',
] as const;

export interface ContextLineRange {
  endLine: number;
  isActive?: boolean;
  startLine: number;
}

/** Display metadata for a root, keyed by RootId (storage v5 descriptor). */
export interface RootDisplayInfo {
  displayName: string;
  path: string;
}

export interface ContextGenerationOptions {
  projectTreeUsesViewFilters?: boolean;
  /**
   * Maps RootId UUID → display metadata. When provided, `<file path>`
   * attributes render `displayName/relative-path` instead of the raw
   * `${rootId}|@|${path}` composite selection key. Content lookups always
   * keep the raw key.
   */
  rootDisplayInfoById?: Record<string, RootDisplayInfo>;
  selectedLineRangesByFile?: Record<string, ContextLineRange[]>;
}

/**
 * Render a selection key as a human-readable path for context output.
 * Storage v5 keys are `${rootId}|@|${path}` with a UUID rootId — resolve the
 * root's displayName and relativize the path. Legacy/undecodable keys pass
 * through unchanged.
 */
function formatContextFilePath(
  selectionKey: string,
  rootDisplayInfoById: Record<string, RootDisplayInfo> | undefined
): string {
  if (!rootDisplayInfoById) {
    return selectionKey;
  }

  let decoded: { folderId: string; path: string };
  try {
    decoded = decodeFileSelection(selectionKey);
  } catch {
    return selectionKey;
  }

  const info = rootDisplayInfoById[decoded.folderId];
  const normalizedPath = decoded.path.replace(/\\/g, '/');
  if (!info) {
    // Unknown root (e.g. disconnected): still never render the UUID.
    return normalizedPath;
  }

  const normalizedRoot = info.path.replace(/\\/g, '/').replace(/\/+$/, '');
  const relativePath =
    normalizedRoot && normalizedPath.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)
      ? normalizedPath.slice(normalizedRoot.length + 1)
      : normalizedPath.replace(/^\/+/, '');

  if (!relativePath) {
    return info.displayName;
  }
  // Web-style paths already start with the root name segment.
  if (relativePath === info.displayName || relativePath.startsWith(`${info.displayName}/`)) {
    return relativePath;
  }
  return `${info.displayName}/${relativePath}`;
}

// File tree processing configuration
interface FileTreeProcessingConfig {
  depth: number;
  maxDepth: number;
  rootFolderId: string;
  visitedPaths: Set<string>;
}

function shouldIgnorePath(pathString: string): boolean {
  const normalizedPath = pathString.replace(/\/+/g, '/').replace(/^\/+/, '');
  return IGNORED_PATTERNS.some((pattern) => pathHasSegment(normalizedPath, pattern));
}

function pathHasSegment(pathString: string, segment: string): boolean {
  let segmentStart = 0;

  while (segmentStart <= pathString.length) {
    const segmentEnd = pathString.indexOf('/', segmentStart);
    const end = segmentEnd === -1 ? pathString.length : segmentEnd;

    // Avoid split() here: this path runs for every adapter tree node during
    // context export, so segment scanning avoids transient arrays and strings.
    if (end - segmentStart === segment.length && pathString.startsWith(segment, segmentStart)) {
      return true;
    }

    if (segmentEnd === -1) {
      return false;
    }
    segmentStart = segmentEnd + 1;
  }

  return false;
}

function createFileNodeBase(
  node: import('@brainstrike/types').IFileNode,
  depth: number,
  rootFolderId: string
): import('@brainstrike/types').IFileNode {
  return {
    ...node,
    depth,
    isDepthTruncated: false,
    isSymbolicLink: false,
    rootFolderId,
    selectionState: 'unchecked',
  };
}

function createChildDirectoryHandle(
  node: import('@brainstrike/types').IFileNode,
  parentHandle: DirectoryHandle
): DirectoryHandle {
  return {
    _internal: node.handle,
    kind: 'directory',
    name: node.name,
    path: node.path,
    platform: parentHandle.platform,
  };
}

export function splitContentLines(content: string): string[] {
  const lines = content.split(/\r?\n/u);
  return lines.length > 0 ? lines : [''];
}

// Pre-compile the regular expression to match all XML-illegal ASCII control characters.
// These are characters < 0x20, EXCEPT tab (0x9), line feed (0xa), and carriage return (0xd).
// eslint-disable-next-line no-control-regex
// biome-ignore lint/suspicious/noControlCharactersInRegex: Intentionally matching control characters for sanitization
const ILLEGAL_XML_CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

function stripXmlIllegalControlChars(value: string): string {
  // Using a pre-compiled regex and native .replace() is significantly faster than
  // iterating over the string with a for...of loop and manual codePoint checks,
  // especially since it avoids intermediate string allocations for clean strings.
  return value.replace(ILLEGAL_XML_CONTROL_CHARS_REGEX, '');
}

function escapeXmlAttribute(value: string): string {
  const sanitized = stripXmlIllegalControlChars(value);
  return sanitized
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;');
}

function clampRange(range: ContextLineRange, totalLines: number): ContextLineRange {
  const safeTotalLines = Math.max(totalLines, 1);
  const maxStart = Math.max(safeTotalLines - 1, 0);
  const startLine = Math.min(Math.max(Math.floor(range.startLine), 0), maxStart);
  const endLine = Math.min(Math.max(Math.floor(range.endLine), startLine + 1), safeTotalLines);
  return { ...range, endLine, startLine };
}

export function normalizeContextLineRanges(
  ranges: ContextLineRange[] | undefined,
  totalLines: number
): ContextLineRange[] {
  if (!ranges || ranges.length === 0) {
    return [];
  }

  const normalized = ranges
    .filter((range) => range.isActive !== false)
    .map((range) => clampRange(range, totalLines))
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  if (normalized.length === 0) {
    return [];
  }

  const merged: ContextLineRange[] = [];
  for (const range of normalized) {
    const current = merged.at(-1);
    if (!current) {
      merged.push(range);
      continue;
    }

    if (range.startLine <= current.endLine) {
      merged[merged.length - 1] = {
        ...current,
        endLine: Math.max(current.endLine, range.endLine),
      };
      continue;
    }

    merged.push(range);
  }

  return merged;
}

function buildFileContextContent(args: {
  filePath: string;
  /** Human-readable path for the `path` attribute; defaults to filePath. */
  displayPath?: string;
  fileContents: Record<string, string>;
  selectedLineRangesByFile?: Record<string, ContextLineRange[]>;
}): string {
  const { filePath, displayPath, fileContents, selectedLineRangesByFile } = args;
  const escapedFilePath = escapeXmlAttribute(displayPath ?? filePath);
  const content =
    fileContents[filePath] ?? `Unable to read file content for ${displayPath ?? filePath}`;
  const fullFileContextContent = `<file path="${escapedFilePath}">
${content}
</file>`;

  // A file whose content was never loaded cannot be sliced by ranges — emit the
  // full/fallback `<file>` path instead of an empty selection.
  if (!(filePath in fileContents)) {
    return fullFileContextContent;
  }

  // Invariant: absence of ranges = whole file. A present-but-EMPTY array is
  // equivalent to absence (empty ≡ absent), so it must be treated as whole file
  // too — only a present, NON-EMPTY range list is "explicit". A present list of
  // all-inactive ranges stays explicit (length > 0) and falls through to the
  // <selection_summary> exclusion notice below.
  const explicitRanges = selectedLineRangesByFile?.[filePath];
  const hasExplicitRangesForFile = explicitRanges !== undefined && explicitRanges.length > 0;

  // If a file has no explicit tapestry ranges, treat it as fully selected.
  // This preserves expected "default hot" behavior for context export.
  if (!hasExplicitRangesForFile) {
    return fullFileContextContent;
  }

  const lines = splitContentLines(content);
  const activeRanges = normalizeContextLineRanges(
    selectedLineRangesByFile?.[filePath],
    lines.length
  );

  if (activeRanges.length === 0) {
    // Keep an explicit marker instead of omitting the file so downstream consumers
    // can distinguish "file intentionally excluded by ranges" from "file omitted".
    // Consumers should treat this as selection metadata, not file content.
    return `<file path="${escapedFilePath}">
<selection_summary>No active tapestry ranges selected.</selection_summary>
</file>`;
  }

  const selections = activeRanges
    .map((range, index) => {
      const selectionContent = lines.slice(range.startLine, range.endLine).join('\n');
      return `<selection index="${index + 1}" start_line="${range.startLine}" end_line="${range.endLine}">
${selectionContent}
</selection>`;
    })
    .join('\n');

  return `<file path="${escapedFilePath}">
${selections}
</file>`;
}

function generateContextContent(
  selectedFiles: Set<string>,
  fileContents: Record<string, string>,
  projectTreeText: string,
  includeProjectTree: boolean,
  options: ContextGenerationOptions
): string {
  // Context export format uses <context>/<relevant_context>; function aliases below
  // preserve API migration compatibility for callers still using "report" naming.
  // File payloads may contain either <selection> blocks or a <selection_summary> metadata marker
  // when all ranges are inactive for a file.
  const relevantContext = `<relevant_context>
${Array.from(selectedFiles)
  .map((filePath) =>
    buildFileContextContent({
      displayPath: formatContextFilePath(filePath, options.rootDisplayInfoById),
      fileContents,
      filePath,
      ...(options.selectedLineRangesByFile
        ? { selectedLineRangesByFile: options.selectedLineRangesByFile }
        : {}),
    })
  )
  .join('\n')}
</relevant_context>`;

  const finalContextParts = ['<context>', relevantContext];

  if (includeProjectTree && projectTreeText) {
    finalContextParts.push(`
<project_tree>
${projectTreeText}
</project_tree>`);
  }

  finalContextParts.push('</context>');

  return finalContextParts.join('\n');
}

async function processDirectoryNode(
  node: import('@brainstrike/types').IFileNode,
  config: FileTreeProcessingConfig,
  fileSystemAdapter: FileSystemAdapter,
  directoryHandle: DirectoryHandle
): Promise<import('@brainstrike/types').IFileNode> {
  const baseNode = createFileNodeBase(node, config.depth, config.rootFolderId);

  if (config.depth >= config.maxDepth - 1) {
    return {
      ...baseNode,
      children: [],
      isDepthTruncated: true,
    };
  }

  if (config.visitedPaths.has(node.path)) {
    return {
      ...baseNode,
      children: [],
      isSymbolicLink: true,
    };
  }

  const childDirectoryHandle = createChildDirectoryHandle(node, directoryHandle);
  const children = await readFullFileTreeFromAdapter(
    fileSystemAdapter,
    childDirectoryHandle,
    node.path,
    config.depth + 1,
    config.rootFolderId,
    config.visitedPaths,
    config.maxDepth
  );

  return {
    ...baseNode,
    children,
  };
}

async function processFileNode(
  node: import('@brainstrike/types').IFileNode,
  config: FileTreeProcessingConfig,
  fileSystemAdapter: FileSystemAdapter,
  directoryHandle: DirectoryHandle
): Promise<import('@brainstrike/types').IFileNode | null> {
  if (node.type === 'file') {
    return createFileNodeBase(node, config.depth, config.rootFolderId);
  }

  if (node.type === 'directory') {
    return processDirectoryNode(node, config, fileSystemAdapter, directoryHandle);
  }

  return null;
}

async function readFullFileTreeFromAdapter(
  fileSystemAdapter: FileSystemAdapter,
  directoryHandle: DirectoryHandle,
  parentPath = '',
  depth = 0,
  rootFolderId = directoryHandle.name,
  visitedPaths: Set<string> = new Set(),
  maxDepth = 30
): Promise<import('@brainstrike/types').IFileNode[]> {
  const currentPath = parentPath || directoryHandle.path;

  if (visitedPaths.has(currentPath)) {
    return [];
  }

  const newVisitedPaths = new Set(visitedPaths);
  newVisitedPaths.add(currentPath);

  const config: FileTreeProcessingConfig = {
    depth,
    maxDepth,
    rootFolderId,
    visitedPaths: newVisitedPaths,
  };

  try {
    const directoryContents = await fileSystemAdapter.readDirectory(directoryHandle);
    const entries: import('@brainstrike/types').IFileNode[] = [];

    for (const node of directoryContents) {
      if (shouldIgnorePath(node.path)) {
        continue;
      }

      const processedNode = await processFileNode(node, config, fileSystemAdapter, directoryHandle);

      if (processedNode) {
        entries.push(processedNode);
      }
    }

    return entries;
  } catch (error) {
    logger.warn('Failed to read directory contents, returning empty node list', {
      depth,
      error,
      path: directoryHandle.path,
    });
    return [];
  }
}

function resolveProjectTreeFilterMode(
  includeFilters: string[],
  excludeFilters: string[],
  useRegex: boolean,
  options: ContextGenerationOptions
): { includeFilters: string[]; excludeFilters: string[]; useRegex: boolean } {
  const useViewFilters = options.projectTreeUsesViewFilters ?? false;

  if (!useViewFilters) {
    return { excludeFilters: [], includeFilters: [], useRegex: false };
  }

  return { excludeFilters, includeFilters, useRegex };
}

// Platform-agnostic version that works with our adapter pattern
export async function generateContextFromAdapter(
  selectedFiles: Set<string>,
  fileContents: Record<string, string>,
  fileSystemAdapter: FileSystemAdapter,
  rootDirectoryHandle: DirectoryHandle,
  includeFilters: string[],
  excludeFilters: string[],
  useRegex: boolean,
  includeProjectTree: boolean,
  folderSummaryThreshold = 5,
  options: ContextGenerationOptions = {}
): Promise<string> {
  let projectTreeText = '';

  if (includeProjectTree) {
    const fullFileTree = await readFullFileTreeFromAdapter(fileSystemAdapter, rootDirectoryHandle);
    const treeFilterMode = resolveProjectTreeFilterMode(
      includeFilters,
      excludeFilters,
      useRegex,
      options
    );
    projectTreeText = generateProjectTreeText(
      fullFileTree,
      treeFilterMode.includeFilters,
      treeFilterMode.excludeFilters,
      treeFilterMode.useRegex,
      folderSummaryThreshold
    );
  }

  return generateContextContent(
    selectedFiles,
    fileContents,
    projectTreeText,
    includeProjectTree,
    options
  );
}

// Web-only version for browser FileSystem APIs
export async function generateContext(
  selectedFiles: Set<string>,
  fileContents: Record<string, string>,
  rootDirectoryHandle: FileSystemDirectoryHandle,
  includeFilters: string[],
  excludeFilters: string[],
  useRegex: boolean,
  includeProjectTree: boolean,
  folderSummaryThreshold = 5,
  options: ContextGenerationOptions = {}
): Promise<string> {
  let projectTreeText = '';

  if (includeProjectTree) {
    const fullFileTree = await readFullFileTree(rootDirectoryHandle);
    const treeFilterMode = resolveProjectTreeFilterMode(
      includeFilters,
      excludeFilters,
      useRegex,
      options
    );
    projectTreeText = generateProjectTreeText(
      fullFileTree,
      treeFilterMode.includeFilters,
      treeFilterMode.excludeFilters,
      treeFilterMode.useRegex,
      folderSummaryThreshold
    );
  }

  return generateContextContent(
    selectedFiles,
    fileContents,
    projectTreeText,
    includeProjectTree,
    options
  );
}

/** @deprecated Use `generateContextFromAdapter` instead. */
export const generateReportFromAdapter = generateContextFromAdapter;

/** @deprecated Use `generateContext` instead. */
export const generateReport = generateContext;
