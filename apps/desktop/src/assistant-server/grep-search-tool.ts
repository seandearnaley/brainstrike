import type { GrepSearchInput, RuntimeData } from '@brainstrike/agent';
import { normalizeOptionalText, resolveWorkspaceIndexEmbeddingSetId } from '@brainstrike/agent';
import type { GrepSearchResult } from '@brainstrike/db';
import { FileChunkRepository, GrepSearchService } from '@brainstrike/db';
import { createLogger } from '@brainstrike/utils/logger';
import type { PGlite } from '@electric-sql/pglite';
import { getDatabase } from '../db-main';

const logger = createLogger('AssistantGrepSearchTool');

export const GREP_SEARCH_TOOL_ID = 'brainstrike.grepSearch' as const;

export async function runGrepSearch(
  input: GrepSearchInput,
  runtimeData: RuntimeData | undefined
): Promise<GrepSearchResult> {
  const db = (await getDatabase()) as unknown as PGlite;
  const repository = new FileChunkRepository(db);
  const service = new GrepSearchService(repository);

  const embeddingSetId =
    normalizeOptionalText(runtimeData?.embeddingSetId) ??
    resolveWorkspaceIndexEmbeddingSetId(runtimeData) ??
    undefined;

  try {
    return await service.search({
      pattern: input.pattern,
      ...(input.isRegex === undefined ? {} : { isRegex: input.isRegex }),
      ...(input.caseSensitive === undefined ? {} : { caseSensitive: input.caseSensitive }),
      ...(input.filePaths === undefined ? {} : { filePaths: input.filePaths }),
      ...(input.contextLines === undefined ? {} : { contextLines: input.contextLines }),
      ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }),
      ...(embeddingSetId === undefined ? {} : { embeddingSetId }),
    });
  } catch (error) {
    logger.error('grepSearch failed', { error, pattern: input.pattern.slice(0, 100) });
    throw error;
  }
}
