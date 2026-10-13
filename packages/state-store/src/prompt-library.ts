import {
  DEFAULT_PROMPT_EMBEDDING_PROFILE,
  type PromptItemWire,
  type PromptLibraryReply,
  type PromptLibraryRequest,
  type PromptVectorPort,
  type PromptVectorState,
} from '@brainstrike/types/prompt-item';
import type {
  PromptCatalogPort,
  PromptCatalogRecord,
  PromptCatalogReply,
} from './prompt-catalog-types.js';

type Metadata = PromptCatalogPort['promptCatalog'];
/** Called under StateStore's existing mutation chain, including joins with its derived index owner. */
export async function executePromptLibrary(
  request: PromptLibraryRequest,
  metadata: Metadata,
  index: PromptVectorPort
): Promise<PromptLibraryReply> {
  const empty: PromptLibraryReply = {
    accepted: true,
    items: [],
    profile: DEFAULT_PROMPT_EMBEDDING_PROFILE,
    revisions: [],
    similarities: [],
  };
  const project = (
    result: PromptCatalogReply,
    states: readonly PromptVectorState[]
  ): PromptLibraryReply => {
    const items: PromptItemWire[] = result.items.map((item) => {
      const state = states.find((row) => row.id === item.id && row.revision === item.revision);
      return {
        ...item,
        embeddingError: state?.error ?? null,
        embeddingProfileId: state && !state.error ? 'default' : null,
        embeddingRevision: state && !state.error ? state.revision : null,
        embeddingStatus: state ? (state.error ? 'error' : 'ready') : 'pending',
        embeddingUpdatedAt: state?.updatedAt ?? null,
      };
    });
    return { ...empty, items, revisions: result.revisions };
  };
  const read = async (result: PromptCatalogReply): Promise<PromptLibraryReply> => {
    if (result.items.length === 0) {
      return project(result, []);
    }
    const status = await index.promptVectors({
      items: result.items.map(({ id, revision }) => ({ id, revision })),
      operation: 'status',
    });
    return project(result, status.rows);
  };
  const required = async (id: string): Promise<PromptCatalogRecord> => {
    const row = (await metadata({ id, operation: 'get' })).items[0];
    if (!row) {
      throw new Error(`Prompt item "${id}" was not found.`);
    }
    return row;
  };
  switch (request.operation) {
    case 'profile':
      return empty;
    case 'list':
    case 'get':
    case 'usage':
    case 'revisions':
      return await read(await metadata(request));
    case 'create':
      return project(await metadata(request), []);
    case 'update': {
      if (!request.input.content.trim()) {
        throw new Error('Prompt item content must contain non-whitespace text.');
      }
      const previous = await required(request.input.id);
      if (previous.revision !== request.input.expectedRevision) {
        throw new Error('Prompt changed since it was opened');
      }
      await index.promptVectors({ ids: [request.input.id], operation: 'delete' });
      return project(await metadata(request), []);
    }
    case 'delete': {
      await required(request.id);
      await index.promptVectors({ ids: [request.id], operation: 'delete' });
      return project(await metadata(request), []);
    }
    case 'pending': {
      const result = await read(await metadata({ filter: {}, operation: 'list' }));
      return {
        ...result,
        items: result.items
          .filter((item) => item.embeddingStatus !== 'ready')
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id)),
      };
    }
    case 'store-embedding':
    case 'embedding-error': {
      const id = request.operation === 'store-embedding' ? request.input.itemId : request.id;
      const revision =
        request.operation === 'store-embedding' ? request.input.revision : request.revision;
      const current = await required(id);
      if (current.revision !== revision) {
        return { ...empty, accepted: false };
      }
      await index.promptVectors(
        request.operation === 'store-embedding'
          ? { id, operation: 'put', revision, vector: request.input.embedding }
          : { error: request.error, id, operation: 'error', revision }
      );
      return empty;
    }
    case 'similar': {
      const { options } = request;
      const limit = options.limit ?? 6;
      const threshold = options.threshold ?? 0.35;
      const candidates = (
        await metadata({
          filter: { ...(options.kinds ? { kinds: options.kinds } : {}) },
          operation: 'list',
        })
      ).items.filter((item) => !options.excludeIds?.includes(item.id));
      const result = await index.promptVectors({
        items: candidates.map(({ id, revision }) => ({ id, revision })),
        limit,
        operation: 'similar',
        threshold,
        vector: request.vector,
      });
      const ranked = result.hits.map((hit) => {
        const item = candidates.find((row) => row.id === hit.id && row.revision === hit.revision);
        if (!item) {
          throw new Error('Prompt vector search returned an unauthorized revision');
        }
        return item;
      });
      return { ...(await read({ items: ranked, revisions: [] })), similarities: result.hits };
    }
  }
}
