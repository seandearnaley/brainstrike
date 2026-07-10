import {
  normalizePromptItemTags,
  type PromptItemImportSnapshot,
  type PromptItemRepository,
} from '@brainstrike/db';

export const LEGACY_PROMPT_STORE_KEY = 'brainstrike-prompt-store';

export interface LegacyPromptStorage {
  readonly getItem: (key: string) => string | null;
  readonly removeItem: (key: string) => void;
}

type PromptImportRepository = Pick<PromptItemRepository, 'importSnapshot'>;

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Legacy prompt store field "${field}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Legacy prompt store field "${field}" must be an array.`);
  }
  return value;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Legacy prompt store field "${field}" must be a string.`);
  }
  return value;
}

function asOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return asString(value, field);
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Legacy prompt store field "${field}" must be a boolean.`);
  }
  return value;
}

function asFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Legacy prompt store field "${field}" must be a finite number.`);
  }
  return value;
}

function asDate(value: unknown, field: string): Date {
  const date = new Date(asFiniteNumber(value, field));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Legacy prompt store field "${field}" is not a valid timestamp.`);
  }
  return date;
}

function asStringArray(value: unknown, field: string): string[] {
  return asArray(value, field).map((entry, index) => asString(entry, `${field}[${index}]`));
}

function asOptionalRecord(value: unknown, field: string): Record<string, unknown> | null {
  if (value === undefined || value === null) {
    return null;
  }
  return { ...asRecord(value, field) };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `Legacy prompt store is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function parseLegacyPromptStore(raw: string): PromptItemImportSnapshot {
  const root = asRecord(parseJson(raw), 'root');
  const state = asRecord(root['state'], 'state');
  const categories = new Map(
    asArray(state['categories'], 'state.categories').map((value, index) => {
      const category = asRecord(value, `state.categories[${index}]`);
      return [
        asString(category['id'], `state.categories[${index}].id`),
        asString(category['name'], `state.categories[${index}].name`),
      ] as const;
    })
  );
  const items = asArray(state['prompts'], 'state.prompts').map((value, index) => {
    const field = `state.prompts[${index}]`;
    const prompt = asRecord(value, field);
    const modelSettings = asOptionalRecord(prompt['modelSettings'], `${field}.modelSettings`);
    const legacyModel = modelSettings?.['model'];
    if (legacyModel !== undefined && typeof legacyModel !== 'string') {
      throw new Error(`Legacy prompt store field "${field}.modelSettings.model" must be a string.`);
    }
    const categoryId = asString(prompt['categoryId'], `${field}.categoryId`);
    const categoryName = categories.get(categoryId);
    const tags = normalizePromptItemTags([
      ...asStringArray(prompt['tags'], `${field}.tags`),
      ...(categoryName ? [categoryName] : []),
    ]);
    const title = asString(prompt['title'], `${field}.title`);
    const revisions = asArray(prompt['revisions'], `${field}.revisions`).map(
      (revisionValue, revisionIndex) => {
        const revisionField = `${field}.revisions[${revisionIndex}]`;
        const revision = asRecord(revisionValue, revisionField);
        const revisionSettings =
          asOptionalRecord(revision['modelSettings'], `${revisionField}.modelSettings`) ??
          modelSettings;
        return {
          content: asString(revision['content'], `${revisionField}.content`),
          createdAt: asDate(revision['timestamp'], `${revisionField}.timestamp`),
          id: asString(revision['id'], `${revisionField}.id`),
          modelKey: null,
          modelSettings: revisionSettings,
          note: asOptionalString(revision['note'], `${revisionField}.note`),
          title,
        };
      }
    );
    return {
      content: asString(prompt['content'], `${field}.content`),
      createdAt: asDate(prompt['createdAt'], `${field}.createdAt`),
      id: asString(prompt['id'], `${field}.id`),
      isFavorite: asBoolean(prompt['isFavorite'], `${field}.isFavorite`),
      kind: 'prompt' as const,
      modelKey: typeof legacyModel === 'string' && legacyModel.includes('::') ? legacyModel : null,
      modelSettings,
      rating: asFiniteNumber(prompt['rating'], `${field}.rating`),
      revisions,
      sourceUrl: asOptionalString(prompt['site'], `${field}.site`),
      tags,
      title,
      updatedAt: asDate(prompt['updatedAt'], `${field}.updatedAt`),
    };
  });
  return { items };
}

const browserLegacyPromptStorage: LegacyPromptStorage = {
  getItem: (key) => {
    if (typeof localStorage === 'undefined') {
      throw new Error('Legacy prompt import requires browser localStorage.');
    }
    return localStorage.getItem(key);
  },
  removeItem: (key) => {
    if (typeof localStorage === 'undefined') {
      throw new Error('Legacy prompt import requires browser localStorage.');
    }
    localStorage.removeItem(key);
  },
};

export async function importLegacyPromptStore(
  repository: PromptImportRepository,
  storage: LegacyPromptStorage = browserLegacyPromptStorage
): Promise<{ imported: number }> {
  const raw = storage.getItem(LEGACY_PROMPT_STORE_KEY);
  if (raw === null) {
    return { imported: 0 };
  }
  const snapshot = parseLegacyPromptStore(raw);
  await repository.importSnapshot(snapshot);
  storage.removeItem(LEGACY_PROMPT_STORE_KEY);
  return { imported: snapshot.items.length };
}
