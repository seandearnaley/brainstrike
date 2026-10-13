import type {
  CreatePromptItemInput,
  PromptItemFilter,
  PromptItemKind,
  PromptItemSimilarityOptions,
  PromptItemUsageAction,
  PromptLibraryRequest,
  UpdatePromptItemInput,
} from '@brainstrike/types/prompt-item';

const kinds = ['prompt', 'snippet', 'fragment'] as const;
const actions = ['compose', 'insert', 'new-thread'] as const;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Prompt request must be an object');
  }
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`Unknown prompt field ${key}`);
    }
  }
}
function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Prompt value must be text');
  }
  return value;
}
function id(value: unknown): string {
  const result = text(value);
  if (!result.trim()) {
    throw new Error('Prompt identity is blank');
  }
  return result;
}
function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error('Prompt integer is outside its bound');
  }
  return value;
}
function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Prompt number must be finite');
  }
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error('Prompt value must be boolean');
  }
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Prompt list must be an array');
  }
  return value.map(text);
}
function member<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error('Prompt choice is invalid');
  }
  return value as T;
}
function promptKinds(value: unknown): PromptItemKind[] {
  return strings(value).map((entry) => member(entry, kinds));
}
function commonInput(input: Record<string, unknown>) {
  return {
    content: text(input['content']),
    description: nullableText(input['description']),
    isFavorite: input['isFavorite'] === undefined ? false : boolean(input['isFavorite']),
    kind: input['kind'] === undefined ? ('fragment' as const) : member(input['kind'], kinds),
    modelKey: nullableText(input['modelKey']),
    modelSettings:
      input['modelSettings'] === null || input['modelSettings'] === undefined
        ? null
        : object(input['modelSettings']),
    rating:
      input['rating'] === null || input['rating'] === undefined
        ? null
        : integer(input['rating'], 0, 5),
    sourceUrl: nullableText(input['sourceUrl']),
    tags: input['tags'] === undefined ? [] : strings(input['tags']),
    title: input['title'] === undefined ? '' : text(input['title']),
  };
}
const inputKeys = [
  'content',
  'title',
  'kind',
  'tags',
  'isFavorite',
  'description',
  'sourceUrl',
  'rating',
  'modelKey',
  'modelSettings',
  'id',
];
function createInput(value: unknown): CreatePromptItemInput {
  const input = object(value);
  keys(input, inputKeys);
  return { ...commonInput(input), ...(input['id'] === undefined ? {} : { id: id(input['id']) }) };
}
function updateInput(value: unknown): UpdatePromptItemInput {
  const input = object(value);
  keys(input, [...inputKeys, 'expectedRevision', 'note']);
  return {
    ...commonInput(input),
    expectedRevision: integer(input['expectedRevision']),
    id: id(input['id']),
    isFavorite: boolean(input['isFavorite']),
    kind: member(input['kind'], kinds),
    note: nullableText(input['note']),
    tags: strings(input['tags']),
  };
}
function filter(value: unknown): PromptItemFilter {
  const input = object(value);
  keys(input, ['favoritesOnly', 'includeArchived', 'kinds', 'search', 'tags']);
  return {
    ...(input['favoritesOnly'] === undefined
      ? {}
      : { favoritesOnly: boolean(input['favoritesOnly']) }),
    ...(input['includeArchived'] === undefined
      ? {}
      : { includeArchived: boolean(input['includeArchived']) }),
    ...(input['kinds'] === undefined ? {} : { kinds: promptKinds(input['kinds']) }),
    ...(input['search'] === undefined ? {} : { search: text(input['search']) }),
    ...(input['tags'] === undefined ? {} : { tags: strings(input['tags']) }),
  };
}
function similarOptions(value: unknown): PromptItemSimilarityOptions {
  const input = object(value);
  keys(input, ['excludeIds', 'kinds', 'limit', 'threshold']);
  const threshold = input['threshold'] === undefined ? 0.35 : finite(input['threshold']);
  if (threshold < -1 || threshold > 1) {
    throw new Error('Prompt threshold must be between -1 and 1');
  }
  return {
    limit: input['limit'] === undefined ? 6 : integer(input['limit'], 1, 20),
    threshold,
    ...(input['excludeIds'] === undefined
      ? {}
      : { excludeIds: strings(input['excludeIds']).map(id) }),
    ...(input['kinds'] === undefined ? {} : { kinds: promptKinds(input['kinds']) }),
  };
}
function vector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== 384) {
    throw new Error('Prompt vector must contain 384 values');
  }
  return value.map(finite);
}
/** Pure schema owner for Main and sandbox preload; no runtime library or Node import. */
export function parsePromptLibraryRequest(value: unknown): PromptLibraryRequest {
  const input = object(value);
  const operation = input['operation'];
  switch (operation) {
    case 'profile':
    case 'pending':
      keys(input, ['operation']);
      return { operation };
    case 'get':
    case 'delete':
    case 'revisions':
      keys(input, ['operation', 'id']);
      return { id: id(input['id']), operation };
    case 'list':
      keys(input, ['operation', 'filter']);
      return { filter: filter(input['filter']), operation };
    case 'create':
      keys(input, ['operation', 'input']);
      return { input: createInput(input['input']), operation };
    case 'update':
      keys(input, ['operation', 'input']);
      return { input: updateInput(input['input']), operation };
    case 'usage':
      keys(input, ['operation', 'id', 'action']);
      return {
        action: member<PromptItemUsageAction>(input['action'], actions),
        id: id(input['id']),
        operation,
      };
    case 'embedding-error':
      keys(input, ['operation', 'id', 'revision', 'error']);
      return {
        error: id(input['error']),
        id: id(input['id']),
        operation,
        revision: integer(input['revision']),
      };
    case 'store-embedding': {
      keys(input, ['operation', 'input']);
      const body = object(input['input']);
      keys(body, ['itemId', 'revision', 'embedding']);
      return {
        input: {
          embedding: vector(body['embedding']),
          itemId: id(body['itemId']),
          revision: integer(body['revision']),
        },
        operation,
      };
    }
    case 'similar':
      keys(input, ['operation', 'vector', 'options']);
      return {
        operation,
        options: similarOptions(input['options']),
        vector: vector(input['vector']),
      };
    default:
      throw new Error('Unknown Prompt Library operation');
  }
}
