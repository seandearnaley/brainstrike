import {
  type ChunkingStrategy,
  type ResolvedChunkingStrategy,
  resolveChunkingStrategyForFile,
} from '@brainstrike/text-splitter';

export function getChunkingStrategy(
  filePath: string,
  requestedStrategy: ChunkingStrategy = 'auto'
): ResolvedChunkingStrategy {
  return resolveChunkingStrategyForFile(filePath, requestedStrategy);
}
