import type { DirectoryHandle, FileHandle, FileSystemAdapter } from '@brainstrike/file-system';
import { readFullFileTree } from './file-system-utils';
import { generateProjectTreeText } from './tree-generator';

// Platform-agnostic version that works with our adapter pattern
export async function generateReportFromAdapter(
  selectedFiles: Set<string>,
  fileContents: { [path: string]: string },
  fileSystemAdapter: FileSystemAdapter,
  rootDirectoryHandle: DirectoryHandle,
  includeFilters: string[],
  excludeFilters: string[],
  useRegex: boolean,
  includeProjectTree: boolean,
  folderSummaryThreshold = 5
): Promise<string> {
  let projectTreeText = '';

  if (includeProjectTree) {
    // Read the full file tree recursively using our adapter
    const fullFileTree = await readFullFileTreeFromAdapter(fileSystemAdapter, rootDirectoryHandle);
    // Generate project tree text
    projectTreeText = generateProjectTreeText(
      fullFileTree,
      includeFilters,
      excludeFilters,
      useRegex,
      folderSummaryThreshold
    );
  }

  return generateReportContent(selectedFiles, fileContents, projectTreeText, includeProjectTree);
}

// Original web-only version for backward compatibility
export async function generateReport(
  selectedFiles: Set<string>,
  fileContents: { [path: string]: string },
  rootDirectoryHandle: FileSystemDirectoryHandle,
  includeFilters: string[],
  excludeFilters: string[],
  useRegex: boolean,
  includeProjectTree: boolean,
  folderSummaryThreshold = 5
): Promise<string> {
  let projectTreeText = '';

  if (includeProjectTree) {
    // Read the full file tree recursively using readFullFileTree from local utils
    const fullFileTree = await readFullFileTree(rootDirectoryHandle);
    // Generate project tree text
    projectTreeText = generateProjectTreeText(
      fullFileTree,
      includeFilters,
      excludeFilters,
      useRegex,
      folderSummaryThreshold
    );
  }

  return generateReportContent(selectedFiles, fileContents, projectTreeText, includeProjectTree);
}

// Shared report content generation logic
function generateReportContent(
  selectedFiles: Set<string>,
  fileContents: { [path: string]: string },
  projectTreeText: string,
  includeProjectTree: boolean
): string {
  // Generate report content
  const reportContent = `<relevant_files>
${Array.from(selectedFiles)
  .map((filePath) => {
    const content = fileContents[filePath] || `Unable to read file content for ${filePath}`;
    return `<file path="${filePath}">
${content}
</file>`;
  })
  .join('\n')}
</relevant_files>`;

  // Construct the final report
  const finalReportParts = ['<report>', reportContent];

  if (includeProjectTree && projectTreeText) {
    finalReportParts.push(`
<project_tree>
${projectTreeText}
</project_tree>`);
  }

  finalReportParts.push('</report>');

  return finalReportParts.join('\n');
}

// Platform-agnostic file tree reading function
async function readFullFileTreeFromAdapter(
  fileSystemAdapter: FileSystemAdapter,
  directoryHandle: DirectoryHandle,
  parentPath = '',
  depth = 0,
  rootFolderId = directoryHandle.name,
  visitedPaths: Set<string> = new Set(),
  maxDepth = 30
): Promise<import('@brainstrike/types').IFileNode[]> {
  const entries: import('@brainstrike/types').IFileNode[] = [];
  const currentPath = parentPath || directoryHandle.path;

  // Check for circular references using paths instead of handles
  if (visitedPaths.has(currentPath)) {
    return entries; // Avoid infinite recursion
  }

  const newVisitedPaths = new Set(visitedPaths);
  newVisitedPaths.add(currentPath);

  try {
    const directoryContents = await fileSystemAdapter.readDirectory(directoryHandle);

    for (const node of directoryContents) {
      const nodePath = node.path;

      // Skip ignored paths (using simple check for common patterns)
      if (shouldIgnorePath(nodePath)) continue;

      if (node.type === 'file') {
        entries.push({
          ...node,
          depth,
          selectionState: 'unchecked',
          rootFolderId,
          isSymbolicLink: false,
          isDepthTruncated: false,
        });
      } else if (node.type === 'directory') {
        // Check depth limit first
        if (depth >= maxDepth - 1) {
          entries.push({
            ...node,
            depth,
            children: [], // No further recursion
            selectionState: 'unchecked',
            rootFolderId,
            isSymbolicLink: false,
            isDepthTruncated: true, // Mark as depth truncated
          });
          continue; // Stop processing this directory further
        }

        // Check for circular references
        if (newVisitedPaths.has(nodePath)) {
          entries.push({
            ...node,
            depth,
            children: [], // No further recursion
            selectionState: 'unchecked',
            rootFolderId,
            isSymbolicLink: true, // Mark as symlink/cycle
            isDepthTruncated: false,
          });
          continue; // Stop processing this directory further
        }

        // Recursively read subdirectory
        const directoryHandle: DirectoryHandle = {
          path: node.path,
          name: node.name,
          kind: 'directory',
          platform: (node.handle as unknown as DirectoryHandle | FileHandle).platform || 'web',
          _internal: (node.handle as unknown as DirectoryHandle | FileHandle)._internal,
        };
        const children = await readFullFileTreeFromAdapter(
          fileSystemAdapter,
          directoryHandle,
          nodePath,
          depth + 1,
          rootFolderId,
          newVisitedPaths,
          maxDepth
        );

        entries.push({
          ...node,
          depth,
          children,
          selectionState: 'unchecked',
          rootFolderId,
          isSymbolicLink: false,
          isDepthTruncated: false,
        });
      }
    }
  } catch (error) {
    console.warn(`Failed to read directory ${currentPath}:`, error);
  }

  return entries;
}

// Simple path ignore check
function shouldIgnorePath(pathString: string): boolean {
  const ignoredPatterns = [
    'node_modules',
    '.git',
    '.DS_Store',
    'dist',
    'build',
    '.turbo',
    'coverage',
    '.nyc_output',
  ];

  const normalizedPath = pathString.replace(/\/+/g, '/').replace(/^\/+/, '');
  return ignoredPatterns.some((pattern) => normalizedPath.split('/').includes(pattern));
}
