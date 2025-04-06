import type { IFileNode } from '@brainstrike/types';
import { fileExplorer } from '../lib/file/explorer';
import { generateProjectTreeText } from './folder-tree-generator';

// Modify generateReport to accept rootDirectoryHandle and be asynchronous
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
    // Read the full file tree recursively using fileExplorer
    const fullFileTree = await fileExplorer.readFullFileTree(rootDirectoryHandle);
    // Generate project tree text
    projectTreeText = generateProjectTreeText(
      fullFileTree,
      includeFilters,
      excludeFilters,
      useRegex,
      folderSummaryThreshold
    );
  }

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
