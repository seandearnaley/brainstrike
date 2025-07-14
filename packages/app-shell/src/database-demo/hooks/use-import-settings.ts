import type { ChunkingStrategy } from '@brainstrike/db';
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import { useState } from 'react';
import type { ImportSettings } from '../types';

const DEFAULT_MODEL_KEY = SimpleEmbeddingService.getDefaultModelKey();

export function useImportSettings(): ImportSettings {
  const [enableChunking, setEnableChunking] = useState(true);
  const [chunkingStrategy, setChunkingStrategy] = useState<ChunkingStrategy>('sentence');
  const [chunkSize, setChunkSize] = useState(500); // Appropriate size for code chunking
  const [chunkOverlap, setChunkOverlap] = useState(50); // 10% overlap
  const [enableEmbedding, setEnableEmbedding] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL_KEY);

  return {
    enableChunking,
    setEnableChunking,
    chunkingStrategy,
    setChunkingStrategy,
    chunkSize,
    setChunkSize,
    chunkOverlap,
    setChunkOverlap,
    enableEmbedding,
    setEnableEmbedding,
    selectedModel,
    setSelectedModel,
  };
}
