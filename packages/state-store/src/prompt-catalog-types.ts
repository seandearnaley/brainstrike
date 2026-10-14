import type {
  CreatePromptItemInput,
  PromptItem,
  PromptItemFilter,
  PromptItemRevision,
  PromptItemUsageAction,
  UpdatePromptItemInput,
} from '@brainstrike/types/prompt-item';

type EmbeddingFields =
  | 'embeddingError'
  | 'embeddingProfileId'
  | 'embeddingRevision'
  | 'embeddingStatus'
  | 'embeddingUpdatedAt';
export type PromptCatalogRecord = Omit<
  PromptItem,
  EmbeddingFields | 'archivedAt' | 'createdAt' | 'updatedAt' | 'lastUsedAt'
> & {
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt: string | null;
};
export type PromptRevisionRecord = Omit<PromptItemRevision, 'createdAt'> & {
  readonly createdAt: string;
};
export type PromptCatalogRequest =
  | { readonly operation: 'create'; readonly input: CreatePromptItemInput }
  | { readonly operation: 'update'; readonly input: UpdatePromptItemInput }
  | { readonly operation: 'get' | 'delete' | 'revisions'; readonly id: string }
  | { readonly operation: 'list'; readonly filter: PromptItemFilter }
  | { readonly operation: 'usage'; readonly id: string; readonly action: PromptItemUsageAction };
export interface PromptCatalogReply {
  readonly items: readonly PromptCatalogRecord[];
  readonly revisions: readonly PromptRevisionRecord[];
}
export interface PromptCatalogPort {
  promptCatalog(request: PromptCatalogRequest): Promise<PromptCatalogReply>;
}
