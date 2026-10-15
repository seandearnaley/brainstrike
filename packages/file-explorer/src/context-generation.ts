import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/types';
import { generateProjectTreeText } from './project-tree-text.js';
import { readFullFileTree } from './read-full-file-tree.js';
import { decodeFileSelection } from './selection.js';

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

function buildFileContextContent(args: {
  filePath: string;
  /** Human-readable path for the `path` attribute; defaults to filePath. */
  displayPath?: string;
  fileContents: Record<string, string>;
}): string {
  const { filePath, displayPath, fileContents } = args;
  const content =
    fileContents[filePath] ?? `Unable to read file content for ${displayPath ?? filePath}`;
  return `<file path="${escapeXmlAttribute(displayPath ?? filePath)}">
${content}
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
  const relevantContext = `<relevant_context>
${Array.from(selectedFiles)
  .map((filePath) =>
    buildFileContextContent({
      displayPath: formatContextFilePath(filePath, options.rootDisplayInfoById),
      fileContents,
      filePath,
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

export async function generateContext(
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
    const fullFileTree = await readFullFileTree(fileSystemAdapter, rootDirectoryHandle);
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

/** @deprecated Use `generateContext` instead. */
export const generateContextFromAdapter = generateContext;

/** @deprecated Use `generateContext` instead. */
export const generateReportFromAdapter = generateContext;

/** @deprecated Use `generateContext` instead. */
export const generateReport = generateContext;
