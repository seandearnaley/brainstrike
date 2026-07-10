export const PROMPT_ITEM_KINDS = ['prompt', 'snippet', 'fragment'] as const;
export type PromptItemKind = (typeof PROMPT_ITEM_KINDS)[number];

export const PROMPT_ITEM_USAGE_ACTIONS = ['compose', 'insert', 'new-thread'] as const;
export type PromptItemUsageAction = (typeof PROMPT_ITEM_USAGE_ACTIONS)[number];

export type PromptItemEmbeddingStatus = 'pending' | 'ready' | 'error';

export interface PromptEmbeddingProfile {
  readonly dimensions: number;
  readonly distance: 'cosine' | 'l2' | 'ip';
  readonly id: string;
  readonly modelId: string;
  readonly modelKey: string;
}

export interface PromptItem {
  readonly archivedAt: Date | null;
  readonly content: string;
  readonly createdAt: Date;
  readonly description: string | null;
  readonly embeddingError: string | null;
  readonly embeddingProfileId: string | null;
  readonly embeddingRevision: number | null;
  readonly embeddingStatus: PromptItemEmbeddingStatus;
  readonly embeddingUpdatedAt: Date | null;
  readonly id: string;
  readonly isFavorite: boolean;
  readonly kind: PromptItemKind;
  readonly lastUsedAction: PromptItemUsageAction | null;
  readonly lastUsedAt: Date | null;
  readonly modelKey: string | null;
  readonly modelSettings: Record<string, unknown> | null;
  readonly rating: number | null;
  readonly revision: number;
  readonly sourceUrl: string | null;
  readonly tags: readonly string[];
  readonly title: string;
  readonly updatedAt: Date;
  readonly useCount: number;
}

export interface PromptItemRevision {
  readonly content: string;
  readonly createdAt: Date;
  readonly description: string | null;
  readonly id: string;
  readonly modelKey: string | null;
  readonly modelSettings: Record<string, unknown> | null;
  readonly note: string | null;
  readonly promptItemId: string;
  readonly revision: number;
  readonly tags: readonly string[];
  readonly title: string;
}

export interface CreatePromptItemInput {
  readonly content: string;
  readonly description?: string | null;
  readonly id?: string;
  readonly isFavorite?: boolean;
  readonly kind?: PromptItemKind;
  readonly modelKey?: string | null;
  readonly modelSettings?: Record<string, unknown> | null;
  readonly rating?: number | null;
  readonly sourceUrl?: string | null;
  readonly tags?: readonly string[];
  readonly title?: string;
}

export interface UpdatePromptItemInput {
  readonly content: string;
  readonly description?: string | null;
  readonly expectedRevision: number;
  readonly id: string;
  readonly isFavorite: boolean;
  readonly kind: PromptItemKind;
  readonly modelKey?: string | null;
  readonly modelSettings?: Record<string, unknown> | null;
  readonly note?: string | null;
  readonly rating?: number | null;
  readonly sourceUrl?: string | null;
  readonly tags: readonly string[];
  readonly title: string;
}

export interface PromptItemFilter {
  readonly favoritesOnly?: boolean;
  readonly includeArchived?: boolean;
  readonly kinds?: readonly PromptItemKind[];
  readonly search?: string;
  readonly tags?: readonly string[];
}

export interface PromptItemSimilarityOptions {
  readonly excludeIds?: readonly string[];
  readonly kinds?: readonly PromptItemKind[];
  readonly limit?: number;
  readonly threshold?: number;
}

export interface PromptItemSimilarityResult extends PromptItem {
  readonly similarity: number;
}

export interface StorePromptItemEmbeddingInput {
  readonly embedding: readonly number[];
  readonly itemId: string;
  readonly revision: number;
}

const DERIVED_TITLE_MAX_LENGTH = 72;

export function derivePromptItemTitle(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .find(Boolean);
  if (!firstLine) {
    throw new Error('Prompt item content must contain non-whitespace text.');
  }
  if (firstLine.length <= DERIVED_TITLE_MAX_LENGTH) {
    return firstLine;
  }
  return `${firstLine.slice(0, DERIVED_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

export function normalizePromptItemTags(tags: readonly string[]): string[] {
  const normalized = tags.map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean);
  return [...new Set(normalized)];
}

export function buildPromptItemEmbeddingText(
  item: Pick<PromptItem, 'content' | 'description' | 'kind' | 'tags' | 'title'>
): string {
  return [
    `Type: ${item.kind}`,
    `Title: ${item.title}`,
    item.description ? `Intent: ${item.description}` : null,
    item.tags.length > 0 ? `Tags: ${item.tags.join(', ')}` : null,
    item.content,
  ]
    .filter((part): part is string => part !== null)
    .join('\n');
}
