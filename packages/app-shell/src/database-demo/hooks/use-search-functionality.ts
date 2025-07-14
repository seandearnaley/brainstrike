import type {
  ElectronFileChunkRepository,
  ElectronFileRecordRepository,
  FileChunk,
  FileChunkRepository,
  FileRecordRepository,
} from '@brainstrike/db';
import type { SimpleEmbeddingService } from '@brainstrike/embeddings';
import type { useToast } from '@brainstrike/ui';
import { useCallback, useState } from 'react';
import type { ChunkSearchResult, SearchFunctionality } from '../types';

export function useSearchFunctionality(
  embeddingService: SimpleEmbeddingService | null,
  chunkRepository: FileChunkRepository | ElectronFileChunkRepository | null,
  repository: FileRecordRepository | ElectronFileRecordRepository | null,
  selectedModel: string,
  toast: ReturnType<typeof useToast>['toast']
): SearchFunctionality {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ChunkSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchThreshold, setSearchThreshold] = useState(0.5);

  const enrichChunkResults = useCallback(
    async (chunkResults: Array<{ chunk: FileChunk; similarity: number }>) => {
      const results: ChunkSearchResult[] = [];
      for (const chunkResult of chunkResults) {
        const fileRecord = await repository?.findById(chunkResult.chunk.fileRecordId);
        if (fileRecord) {
          results.push({
            chunk: chunkResult.chunk,
            similarity: chunkResult.similarity,
            fileRecord,
          });
        }
      }
      return results;
    },
    [repository]
  );

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim() || !embeddingService || !chunkRepository) {
      return;
    }

    setSearching(true);
    try {
      const status = embeddingService.getStatus();
      if (status !== 'ready') {
        await embeddingService.initializeWithModel(selectedModel);
      }

      const queryEmbedding = await embeddingService.generateEmbedding(searchQuery);
      const chunkResults = await chunkRepository.searchSimilar(queryEmbedding.embedding, {
        limit: 20,
        threshold: searchThreshold,
      });

      const results = await enrichChunkResults(chunkResults);
      setSearchResults(results);
    } catch (error) {
      toast({
        title: 'Search Failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setSearching(false);
    }
  }, [
    searchQuery,
    embeddingService,
    chunkRepository,
    selectedModel,
    searchThreshold,
    enrichChunkResults,
    toast,
  ]);

  return {
    searchQuery,
    setSearchQuery,
    searchResults,
    searching,
    searchThreshold,
    setSearchThreshold,
    handleSearch,
  };
}
