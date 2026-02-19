/**
 * Shared utility functions for the CollectionBrowser.
 */

import type { BrowserNodeData, ChunkData, CollectionData, EmbeddingData, FileData } from './types';

/**
 * Shorten a file path for display while keeping it informative.
 * - Replaces home directory with ~
 * - Collapses middle segments if path exceeds maxLength
 * - Preserves filename and immediate parent for context
 *
 * @param path - The full file path
 * @param maxLength - Maximum display length (default: 50)
 * @returns Shortened path string
 */
export function shortenPath(path: string, maxLength = 50): string {
  if (!path || path.length <= maxLength) {
    return path;
  }

  // Replace common home directory patterns with ~
  const homePatterns = [/^\/Users\/[^/]+/, /^\/home\/[^/]+/, /^C:\\Users\\[^\\]+/i];

  let shortenedPath = path;
  for (const pattern of homePatterns) {
    if (pattern.test(path)) {
      shortenedPath = path.replace(pattern, '~');
      break;
    }
  }

  // If still too long, collapse middle segments
  if (shortenedPath.length > maxLength) {
    const separator = path.includes('\\') ? '\\' : '/';
    const parts = shortenedPath.split(separator);

    if (parts.length > 3) {
      // Keep first segment (~ or root), ellipsis, and last 2 segments
      const first = parts[0];
      const lastTwo = parts.slice(-2);
      shortenedPath = [first, '\u2026', ...lastTwo].join(separator);
    }
  }

  return shortenedPath;
}

/**
 * Get display name and subtitle for a node
 */
export function getNodeDisplayInfo(
  type: string,
  data: BrowserNodeData
): { displayName: string; subtitle: string } {
  switch (type) {
    case 'collection': {
      const collData = data as CollectionData;
      return {
        displayName: collData.name,
        subtitle: `${collData.fileCount} files \u2022 ${collData.chunkCount} chunks`,
      };
    }
    case 'file': {
      const fileData = data as FileData;
      return { displayName: fileData.name, subtitle: shortenPath(fileData.path) };
    }
    case 'chunk': {
      const chunkData = data as ChunkData;
      const content = chunkData.content;
      return {
        displayName: `Chunk #${chunkData.index}`,
        subtitle: content.slice(0, 60) + (content.length > 60 ? '...' : ''),
      };
    }
    case 'embedding': {
      const embData = data as EmbeddingData;
      return { displayName: 'Vector', subtitle: `${embData.dimensions} dimensions` };
    }
    default:
      return { displayName: '', subtitle: '' };
  }
}
