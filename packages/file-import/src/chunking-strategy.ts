import type { ChunkingStrategy } from '@brainstrike/db';
import { fileExplorer } from '@brainstrike/utils';

export function getChunkingStrategy(
  filePath: string,
  defaultStrategy?: ChunkingStrategy
): ChunkingStrategy {
  if (defaultStrategy) {
    return defaultStrategy;
  }

  const extension = fileExplorer.getFileExtension(filePath);
  const codeExtensions = [
    'js',
    'ts',
    'jsx',
    'tsx',
    'py',
    'java',
    'cpp',
    'c',
    'h',
    'cs',
    'php',
    'rb',
    'go',
    'rs',
  ];

  if (codeExtensions.includes(extension)) {
    return 'recursive';
  }

  return 'sentence';
}
