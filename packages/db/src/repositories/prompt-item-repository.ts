import {
  type CreatePromptItemInput,
  derivePromptItemTitle,
  normalizePromptItemTags,
  type PromptEmbeddingProfile,
  type PromptItem,
  type PromptItemEmbeddingStatus,
  type PromptItemFilter,
  type PromptItemKind,
  type PromptItemRevision,
  type PromptItemSimilarityOptions,
  type PromptItemSimilarityResult,
  type PromptItemUsageAction,
  type StorePromptItemEmbeddingInput,
  type UpdatePromptItemInput,
} from '../models/prompt-item.js';
import { escapeLikeLiteral } from '../search/grep-pattern.js';

export interface PromptItemDatabase {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}

interface PromptItemRow {
  archivedAt: Date | string | null;
  content: string;
  createdAt: Date | string;
  description: string | null;
  embeddingError: string | null;
  embeddingProfileId: string | null;
  embeddingRevision: number | null;
  embeddingUpdatedAt: Date | string | null;
  hasEmbedding: boolean;
  id: string;
  isFavorite: boolean;
  kind: PromptItemKind;
  lastUsedAction: PromptItemUsageAction | null;
  lastUsedAt: Date | string | null;
  modelKey: string | null;
  modelSettings: unknown;
  rating: number | null;
  revision: number;
  sourceUrl: string | null;
  tags: unknown;
  title: string;
  updatedAt: Date | string;
  useCount: number;
}

interface PromptItemRevisionRow {
  content: string;
  createdAt: Date | string;
  description: string | null;
  id: string;
  modelKey: string | null;
  modelSettings: unknown;
  note: string | null;
  promptItemId: string;
  revision: number;
  tags: unknown;
  title: string;
}

const DEFAULT_PROMPT_EMBEDDING_PROFILE_ID = 'default';
const MAX_SIMILARITY_RESULTS = 20;

const PROMPT_ITEM_COLUMNS = `
  id,
  kind,
  title,
  content,
  description,
  tags,
  is_favorite AS "isFavorite",
  archived_at AS "archivedAt",
  source_url AS "sourceUrl",
  rating,
  model_key AS "modelKey",
  model_settings AS "modelSettings",
  revision,
  use_count AS "useCount",
  last_used_at AS "lastUsedAt",
  last_used_action AS "lastUsedAction",
  embedding_profile_id AS "embeddingProfileId",
  embedding_revision AS "embeddingRevision",
  embedding_error AS "embeddingError",
  embedding_updated_at AS "embeddingUpdatedAt",
  embedding IS NOT NULL AS "hasEmbedding",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function promptItemColumnsFor(alias: string): string {
  return `
    ${alias}.id,
    ${alias}.kind,
    ${alias}.title,
    ${alias}.content,
    ${alias}.description,
    ${alias}.tags,
    ${alias}.is_favorite AS "isFavorite",
    ${alias}.archived_at AS "archivedAt",
    ${alias}.source_url AS "sourceUrl",
    ${alias}.rating,
    ${alias}.model_key AS "modelKey",
    ${alias}.model_settings AS "modelSettings",
    ${alias}.revision,
    ${alias}.use_count AS "useCount",
    ${alias}.last_used_at AS "lastUsedAt",
    ${alias}.last_used_action AS "lastUsedAction",
    ${alias}.embedding_profile_id AS "embeddingProfileId",
    ${alias}.embedding_revision AS "embeddingRevision",
    ${alias}.embedding_error AS "embeddingError",
    ${alias}.embedding_updated_at AS "embeddingUpdatedAt",
    ${alias}.embedding IS NOT NULL AS "hasEmbedding",
    ${alias}.created_at AS "createdAt",
    ${alias}.updated_at AS "updatedAt"
  `;
}

function createId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('Prompt library requires crypto.randomUUID().');
  }
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

function asDate(value: Date | string, field: string): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Prompt library returned an invalid ${field} timestamp.`);
  }
  return date;
}

function asNullableDate(value: Date | string | null, field: string): Date | null {
  return value === null ? null : asDate(value, field);
}

function asStringArray(value: unknown, field: string): string[] {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Prompt library returned invalid ${field}.`);
  }
  return [...parsed];
}

function asNullableRecord(value: unknown, field: string): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Prompt library returned invalid ${field}.`);
  }
  return { ...(parsed as Record<string, unknown>) };
}

function resolveEmbeddingStatus(row: PromptItemRow): PromptItemEmbeddingStatus {
  if (row.embeddingError) {
    return 'error';
  }
  return row.hasEmbedding && row.embeddingRevision === row.revision ? 'ready' : 'pending';
}

function mapPromptItem(row: PromptItemRow): PromptItem {
  return {
    archivedAt: asNullableDate(row.archivedAt, 'archivedAt'),
    content: row.content,
    createdAt: asDate(row.createdAt, 'createdAt'),
    description: row.description,
    embeddingError: row.embeddingError,
    embeddingProfileId: row.embeddingProfileId,
    embeddingRevision: row.embeddingRevision,
    embeddingStatus: resolveEmbeddingStatus(row),
    embeddingUpdatedAt: asNullableDate(row.embeddingUpdatedAt, 'embeddingUpdatedAt'),
    id: row.id,
    isFavorite: row.isFavorite,
    kind: row.kind,
    lastUsedAction: row.lastUsedAction,
    lastUsedAt: asNullableDate(row.lastUsedAt, 'lastUsedAt'),
    modelKey: row.modelKey,
    modelSettings: asNullableRecord(row.modelSettings, 'modelSettings'),
    rating: row.rating,
    revision: row.revision,
    sourceUrl: row.sourceUrl,
    tags: asStringArray(row.tags, 'tags'),
    title: row.title,
    updatedAt: asDate(row.updatedAt, 'updatedAt'),
    useCount: row.useCount,
  };
}

function mapRevision(row: PromptItemRevisionRow): PromptItemRevision {
  return {
    content: row.content,
    createdAt: asDate(row.createdAt, 'revision.createdAt'),
    description: row.description,
    id: row.id,
    modelKey: row.modelKey,
    modelSettings: asNullableRecord(row.modelSettings, 'revision.modelSettings'),
    note: row.note,
    promptItemId: row.promptItemId,
    revision: row.revision,
    tags: asStringArray(row.tags, 'revision.tags'),
    title: row.title,
  };
}

function requireContent(content: string): void {
  if (!content.trim()) {
    throw new Error('Prompt item content must contain non-whitespace text.');
  }
}

function normalizeTitle(title: string | undefined, content: string): string {
  const normalized = title?.trim();
  return normalized || derivePromptItemTitle(content);
}

function toJson(value: Record<string, unknown> | null | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}

function toVectorLiteral(embedding: readonly number[], expectedDimensions: number): string {
  if (embedding.length !== expectedDimensions) {
    throw new Error(
      `Prompt embedding dimension mismatch: received ${embedding.length}, expected ${expectedDimensions}.`
    );
  }
  embedding.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      throw new Error(`Prompt embedding contains a non-finite value at index ${index}.`);
    }
  });
  return `[${embedding.join(',')}]`;
}

export class PromptItemRepository {
  constructor(private readonly db: PromptItemDatabase) {}

  async getEmbeddingProfile(): Promise<PromptEmbeddingProfile> {
    const result = await this.db.query<{
      dimensions: number;
      distance: PromptEmbeddingProfile['distance'];
      id: string;
      modelId: string;
      modelKey: string;
    }>(
      `SELECT id, model_id AS "modelId", model_key AS "modelKey", dimensions, distance
       FROM prompt_embedding_profiles
       WHERE id = $1`,
      [DEFAULT_PROMPT_EMBEDDING_PROFILE_ID]
    );
    const profile = result.rows[0];
    if (!profile) {
      throw new Error('Prompt embedding profile is missing. Run database migrations.');
    }
    if (!(Number.isInteger(profile.dimensions) && profile.dimensions > 0)) {
      throw new Error('Prompt embedding profile has invalid dimensions.');
    }
    return { ...profile };
  }

  async create(input: CreatePromptItemInput): Promise<PromptItem> {
    requireContent(input.content);
    const id = input.id ?? createId('prompt-item');
    const result = await this.db.query<PromptItemRow>(
      `INSERT INTO prompt_items (
         id, kind, title, content, description, tags, is_favorite,
         source_url, rating, model_key, model_settings
       ) VALUES (
         $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11::jsonb
       )
       RETURNING ${PROMPT_ITEM_COLUMNS}`,
      [
        id,
        input.kind ?? 'fragment',
        normalizeTitle(input.title, input.content),
        input.content,
        input.description?.trim() || null,
        JSON.stringify(normalizePromptItemTags(input.tags ?? [])),
        input.isFavorite ?? false,
        input.sourceUrl?.trim() || null,
        input.rating ?? null,
        input.modelKey?.trim() || null,
        toJson(input.modelSettings),
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Failed to create prompt item "${id}".`);
    }
    return mapPromptItem(row);
  }

  async findById(id: string): Promise<PromptItem | null> {
    const result = await this.db.query<PromptItemRow>(
      `SELECT ${PROMPT_ITEM_COLUMNS} FROM prompt_items WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? mapPromptItem(result.rows[0]) : null;
  }

  async list(filter: PromptItemFilter = {}): Promise<PromptItem[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!filter.includeArchived) {
      where.push('archived_at IS NULL');
    }
    if (filter.favoritesOnly) {
      where.push('is_favorite = TRUE');
    }
    if (filter.kinds && filter.kinds.length > 0) {
      const placeholders = filter.kinds.map((kind) => {
        params.push(kind);
        return `$${params.length}`;
      });
      where.push(`kind IN (${placeholders.join(', ')})`);
    }
    if (filter.tags && filter.tags.length > 0) {
      params.push(JSON.stringify(normalizePromptItemTags(filter.tags)));
      where.push(`tags @> $${params.length}::jsonb`);
    }
    const search = filter.search?.trim();
    if (search) {
      params.push(`%${escapeLikeLiteral(search)}%`);
      where.push(
        `(title ILIKE $${params.length} ESCAPE '\\' OR content ILIKE $${params.length} ESCAPE '\\' OR description ILIKE $${params.length} ESCAPE '\\')`
      );
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const result = await this.db.query<PromptItemRow>(
      `SELECT ${PROMPT_ITEM_COLUMNS}
       FROM prompt_items
       ${clause}
       ORDER BY is_favorite DESC, updated_at DESC, id ASC`,
      params
    );
    return result.rows.map(mapPromptItem);
  }

  async update(input: UpdatePromptItemInput): Promise<PromptItem> {
    requireContent(input.content);
    const result = await this.db.query<PromptItemRow>(
      `WITH current_item AS (
         SELECT * FROM prompt_items WHERE id = $3 AND revision = $4
       ), saved_revision AS (
         INSERT INTO prompt_item_revisions (
           id, prompt_item_id, revision, title, content, description,
           tags, model_key, model_settings, note
         )
         SELECT $1, id, revision, title, content, description,
                tags, model_key, model_settings, $2
         FROM current_item
         RETURNING prompt_item_id
       )
       UPDATE prompt_items AS item
       SET kind = $5,
           title = $6,
           content = $7,
           description = $8,
           tags = $9::jsonb,
           is_favorite = $10,
           source_url = $11,
           rating = $12,
           model_key = $13,
           model_settings = $14::jsonb,
           revision = item.revision + 1,
           embedding = NULL,
           embedding_profile_id = NULL,
           embedding_revision = NULL,
           embedding_error = NULL,
           embedding_updated_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       FROM saved_revision
       WHERE item.id = $3
         AND item.id = saved_revision.prompt_item_id
         AND item.revision = $4
       RETURNING ${promptItemColumnsFor('item')}`,
      [
        createId('prompt-revision'),
        input.note?.trim() || null,
        input.id,
        input.expectedRevision,
        input.kind,
        normalizeTitle(input.title, input.content),
        input.content,
        input.description?.trim() || null,
        JSON.stringify(normalizePromptItemTags(input.tags)),
        input.isFavorite,
        input.sourceUrl?.trim() || null,
        input.rating ?? null,
        input.modelKey?.trim() || null,
        toJson(input.modelSettings),
      ]
    );
    const row = result.rows[0];
    if (row) {
      return mapPromptItem(row);
    }
    const current = await this.findById(input.id);
    if (!current) {
      throw new Error(`Prompt item "${input.id}" was not found.`);
    }
    throw new Error(
      `Prompt item "${input.id}" changed since it was opened (expected revision ${input.expectedRevision}, current revision ${current.revision}).`
    );
  }

  async listRevisions(itemId: string): Promise<PromptItemRevision[]> {
    const result = await this.db.query<PromptItemRevisionRow>(
      `SELECT
         id,
         prompt_item_id AS "promptItemId",
         revision,
         title,
         content,
         description,
         tags,
         model_key AS "modelKey",
         model_settings AS "modelSettings",
         note,
         created_at AS "createdAt"
       FROM prompt_item_revisions
       WHERE prompt_item_id = $1
       ORDER BY revision DESC`,
      [itemId]
    );
    return result.rows.map(mapRevision);
  }

  async storeEmbedding(input: StorePromptItemEmbeddingInput): Promise<boolean> {
    const profile = await this.getEmbeddingProfile();
    const vector = toVectorLiteral(input.embedding, profile.dimensions);
    const result = await this.db.query<{ id: string }>(
      `UPDATE prompt_items
       SET embedding = $1::vector,
           embedding_profile_id = $2,
           embedding_revision = $3,
           embedding_error = NULL,
           embedding_updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND revision = $3
       RETURNING id`,
      [vector, profile.id, input.revision, input.itemId]
    );
    if (result.rows[0]) {
      return true;
    }
    if (!(await this.findById(input.itemId))) {
      throw new Error(`Prompt item "${input.itemId}" was not found.`);
    }
    return false;
  }

  async markEmbeddingError(itemId: string, revision: number, error: string): Promise<boolean> {
    const message = error.trim();
    if (!message) {
      throw new Error('Prompt embedding errors must include a message.');
    }
    const result = await this.db.query<{ id: string }>(
      `UPDATE prompt_items
       SET embedding = NULL,
           embedding_profile_id = NULL,
           embedding_revision = NULL,
           embedding_error = $1,
           embedding_updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND revision = $3
       RETURNING id`,
      [message, itemId, revision]
    );
    if (result.rows[0]) {
      return true;
    }
    if (!(await this.findById(itemId))) {
      throw new Error(`Prompt item "${itemId}" was not found.`);
    }
    return false;
  }

  async listNeedingEmbedding(): Promise<PromptItem[]> {
    const result = await this.db.query<PromptItemRow>(
      `SELECT ${PROMPT_ITEM_COLUMNS}
       FROM prompt_items
       WHERE archived_at IS NULL
         AND (embedding IS NULL OR embedding_revision IS DISTINCT FROM revision)
       ORDER BY updated_at ASC, id ASC`
    );
    return result.rows.map(mapPromptItem);
  }

  async searchSimilar(
    queryEmbedding: readonly number[],
    options: PromptItemSimilarityOptions = {}
  ): Promise<PromptItemSimilarityResult[]> {
    const profile = await this.getEmbeddingProfile();
    if (profile.distance !== 'cosine') {
      throw new Error(
        `Prompt similarity search only supports cosine distance; profile "${profile.id}" uses "${profile.distance}".`
      );
    }
    const queryVector = toVectorLiteral(queryEmbedding, profile.dimensions);
    const limit = options.limit ?? 6;
    if (!(Number.isInteger(limit) && limit > 0 && limit <= MAX_SIMILARITY_RESULTS)) {
      throw new Error(`Prompt similarity limit must be between 1 and ${MAX_SIMILARITY_RESULTS}.`);
    }
    const threshold = options.threshold ?? 0.35;
    if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) {
      throw new Error('Prompt similarity threshold must be a finite value between -1 and 1.');
    }

    const params: unknown[] = [queryVector, profile.id, threshold];
    const where = [
      'item.archived_at IS NULL',
      'item.embedding IS NOT NULL',
      'item.embedding_profile_id = $2',
      'item.embedding_revision = item.revision',
      'item.embedding_error IS NULL',
      '1 - (item.embedding <=> $1::vector) >= $3',
    ];
    if (options.kinds && options.kinds.length > 0) {
      const placeholders = options.kinds.map((kind) => {
        params.push(kind);
        return `$${params.length}`;
      });
      where.push(`item.kind IN (${placeholders.join(', ')})`);
    }
    if (options.excludeIds && options.excludeIds.length > 0) {
      const placeholders = options.excludeIds.map((id) => {
        params.push(id);
        return `$${params.length}`;
      });
      where.push(`item.id NOT IN (${placeholders.join(', ')})`);
    }
    params.push(limit);

    const result = await this.db.query<PromptItemRow & { similarity: number | string }>(
      `SELECT
         ${promptItemColumnsFor('item')},
         1 - (item.embedding <=> $1::vector) AS similarity
       FROM prompt_items AS item
       WHERE ${where.join(' AND ')}
       ORDER BY item.embedding <=> $1::vector ASC, item.updated_at DESC
       LIMIT $${params.length}`,
      params
    );
    return result.rows.map((row) => ({
      ...mapPromptItem(row),
      similarity: Number(row.similarity),
    }));
  }

  async recordUsage(id: string, action: PromptItemUsageAction): Promise<PromptItem> {
    const result = await this.db.query<PromptItemRow>(
      `UPDATE prompt_items
       SET use_count = use_count + 1,
           last_used_at = CURRENT_TIMESTAMP,
           last_used_action = $2
       WHERE id = $1
       RETURNING ${PROMPT_ITEM_COLUMNS}`,
      [id, action]
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Prompt item "${id}" was not found.`);
    }
    return mapPromptItem(row);
  }

  async delete(id: string): Promise<void> {
    const result = await this.db.query<{ id: string }>(
      'DELETE FROM prompt_items WHERE id = $1 RETURNING id',
      [id]
    );
    if (!result.rows[0]) {
      throw new Error(`Prompt item "${id}" was not found.`);
    }
  }
}
