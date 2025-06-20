import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
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
  const currentPath = parentPath || directoryHandle.path;

  // Check for circular references using paths instead of handles
  if (visitedPaths.has(currentPath)) {
    return []; // Avoid infinite recursion
  }

  const newVisitedPaths = new Set(visitedPaths);
  newVisitedPaths.add(currentPath);

  try {
    const directoryContents = await fileSystemAdapter.readDirectory(directoryHandle);
    const entries: import('@brainstrike/types').IFileNode[] = [];

    for (const node of directoryContents) {
      if (shouldIgnorePath(node.path)) continue;

      const processedNode = await processFileNode(
        node,
        depth,
        rootFolderId,
        fileSystemAdapter,
        directoryHandle,
        newVisitedPaths,
        maxDepth
      );

      if (processedNode) {
        entries.push(processedNode);
      }
    }

    return entries;
  } catch (error) {
    console.warn(`Failed to read directory ${currentPath}:`, error);
    return [];
  }
}

// Process individual file or directory nodes
async function processFileNode(
  node: import('@brainstrike/types').IFileNode,
  depth: number,
  rootFolderId: string,
  fileSystemAdapter: FileSystemAdapter,
  directoryHandle: DirectoryHandle,
  visitedPaths: Set<string>,
  maxDepth: number
): Promise<import('@brainstrike/types').IFileNode | null> {
  if (node.type === 'file') {
    return createFileNode(node, depth, rootFolderId);
  }

  if (node.type === 'directory') {
    return await processDirectoryNode(
      node,
      depth,
      rootFolderId,
      fileSystemAdapter,
      directoryHandle,
      visitedPaths,
      maxDepth
    );
  }

  return null;
}

// Create a file node with standard properties
function createFileNode(
  node: import('@brainstrike/types').IFileNode,
  depth: number,
  rootFolderId: string
): import('@brainstrike/types').IFileNode {
  return {
    ...node,
    depth,
    selectionState: 'unchecked',
    rootFolderId,
    isSymbolicLink: false,
    isDepthTruncated: false,
  };
}

// Process directory nodes with depth and circular reference checks
async function processDirectoryNode(
  node: import('@brainstrike/types').IFileNode,
  depth: number,
  rootFolderId: string,
  fileSystemAdapter: FileSystemAdapter,
  directoryHandle: DirectoryHandle,
  visitedPaths: Set<string>,
  maxDepth: number
): Promise<import('@brainstrike/types').IFileNode> {
  const baseNode = createFileNode(node, depth, rootFolderId);

  // Check depth limit first
  if (depth >= maxDepth - 1) {
    return {
      ...baseNode,
      children: [],
      isDepthTruncated: true,
    };
  }

  // Check for circular references
  if (visitedPaths.has(node.path)) {
    return {
      ...baseNode,
      children: [],
      isSymbolicLink: true,
    };
  }

  // Recursively read subdirectory
  const childDirectoryHandle = createChildDirectoryHandle(node, directoryHandle);
  const children = await readFullFileTreeFromAdapter(
    fileSystemAdapter,
    childDirectoryHandle,
    node.path,
    depth + 1,
    rootFolderId,
    visitedPaths,
    maxDepth
  );

  return {
    ...baseNode,
    children,
  };
}

// Create a child directory handle from a node
function createChildDirectoryHandle(
  node: import('@brainstrike/types').IFileNode,
  parentHandle: DirectoryHandle
): DirectoryHandle {
  return {
    path: node.path,
    name: node.name,
    kind: 'directory',
    platform: parentHandle.platform,
    _internal: node.handle,
  };
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
