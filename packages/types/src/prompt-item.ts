export const PROMPT_ITEM_KINDS = ['prompt', 'snippet', 'fragment'] as const;
export type PromptItemKind = (typeof PROMPT_ITEM_KINDS)[number];

export const PROMPT_ITEM_USAGE_ACTIONS = ['compose', 'insert', 'new-thread'] as const;
export type PromptItemUsageAction = (typeof PROMPT_ITEM_USAGE_ACTIONS)[number];

export interface PromptItem {
  readonly archivedAt: Date | null;
  readonly content: string;
  readonly createdAt: Date;
  readonly description: string | null;
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

export type PromptItemWire = Omit<
  PromptItem,
  'archivedAt' | 'createdAt' | 'updatedAt' | 'lastUsedAt'
> & {
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt: string | null;
};
export type PromptRevisionWire = Omit<PromptItemRevision, 'createdAt'> & {
  readonly createdAt: string;
};
export type PromptLibraryRequest =
  | { readonly operation: 'list'; readonly filter: PromptItemFilter }
  | { readonly operation: 'get' | 'delete' | 'revisions'; readonly id: string }
  | { readonly operation: 'create'; readonly input: CreatePromptItemInput }
  | { readonly operation: 'update'; readonly input: UpdatePromptItemInput }
  | { readonly operation: 'usage'; readonly id: string; readonly action: PromptItemUsageAction };
export interface PromptLibraryReply {
  readonly items: readonly PromptItemWire[];
  readonly revisions: readonly PromptRevisionWire[];
}
export interface PromptLibraryCapability {
  request(input: PromptLibraryRequest): Promise<PromptLibraryReply>;
}
export interface PromptItemRepositoryPort {
  create(input: CreatePromptItemInput): Promise<PromptItem>;
  delete(id: string): Promise<void>;
  findById(id: string): Promise<PromptItem | null>;
  list(filter?: PromptItemFilter): Promise<PromptItem[]>;
  listRevisions(id: string): Promise<PromptItemRevision[]>;
  recordUsage(id: string, action: PromptItemUsageAction): Promise<PromptItem>;
  update(input: UpdatePromptItemInput): Promise<PromptItem>;
}
