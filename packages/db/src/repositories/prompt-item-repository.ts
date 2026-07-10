import type { TransactionStatement } from '../atomic-transaction.js';
import {
  type CreatePromptItemInput,
  derivePromptItemTitle,
  type ImportPromptItem,
  type ImportPromptItemRevision,
  normalizePromptItemTags,
  type PromptEmbeddingProfile,
  type PromptItem,
  type PromptItemEmbeddingStatus,
  type PromptItemFilter,
  type PromptItemImportSnapshot,
  type PromptItemKind,
  type PromptItemRevision,
  type PromptItemSimilarityOptions,
  type PromptItemSimilarityResult,
  type PromptItemUsageAction,
  type StorePromptItemEmbeddingInput,
  type UpdatePromptItemInput,
} from '../models/prompt-item.js';

export interface PromptItemDatabase {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  runTransaction?: (
    statements: TransactionStatement[],
    resultIndex: number
  ) => Promise<{ rows: unknown[] }>;
  transaction?: <T>(fn: (tx: PromptItemDatabase) => Promise<T>) => Promise<T>;
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

interface PreparedImportPromptItem {
  item: ImportPromptItem;
  normalizedTags: readonly string[];
  normalizedTitle: string;
  sortedRevisions: readonly ImportPromptItemRevision[];
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

function assertValidImportDate(date: Date, field: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error(`Legacy prompt import contains an invalid ${field} timestamp.`);
  }
}

function sortComparableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortComparableJson);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortComparableJson(entry)])
    );
  }
  return value;
}

function comparable(value: unknown): string {
  const serialized = JSON.stringify(value ?? null);
  if (serialized === undefined) {
    return 'null';
  }
  return JSON.stringify(sortComparableJson(JSON.parse(serialized) as unknown));
}

function sortAndValidateImportedRevisions(item: ImportPromptItem): ImportPromptItemRevision[] {
  const sorted = [...item.revisions].sort(
    (left, right) => left.createdAt.getTime() - right.createdAt.getTime()
  );
  sorted.forEach((revision) => {
    requireContent(revision.content);
    assertValidImportDate(revision.createdAt, 'revision.createdAt');
  });
  return sorted;
}

function prepareImportedItem(item: ImportPromptItem): PreparedImportPromptItem {
  requireContent(item.content);
  assertValidImportDate(item.createdAt, 'createdAt');
  assertValidImportDate(item.updatedAt, 'updatedAt');
  return {
    item,
    normalizedTags: normalizePromptItemTags(item.tags),
    normalizedTitle: normalizeTitle(item.title, item.content),
    sortedRevisions: sortAndValidateImportedRevisions(item),
  };
}

function importedItemMatches(
  existing: PromptItem,
  existingRevisions: readonly PromptItemRevision[],
  item: ImportPromptItem,
  normalizedTags: readonly string[],
  normalizedTitle: string,
  sortedRevisions: readonly ImportPromptItemRevision[]
): boolean {
  const normalizedDescription = item.description?.trim() || null;
  const ascendingExistingRevisions = [...existingRevisions].sort(
    (left, right) => left.revision - right.revision
  );
  const currentItemMatches =
    existing.content === item.content &&
    existing.title === normalizedTitle &&
    existing.kind === item.kind &&
    existing.description === normalizedDescription &&
    existing.isFavorite === item.isFavorite &&
    comparable(existing.tags) === comparable(normalizedTags) &&
    comparable(existing.modelSettings) === comparable(item.modelSettings) &&
    existing.modelKey === (item.modelKey?.trim() || null) &&
    existing.sourceUrl === (item.sourceUrl?.trim() || null) &&
    existing.rating === (item.rating ?? null) &&
    existing.revision === sortedRevisions.length + 1 &&
    existing.createdAt.getTime() === item.createdAt.getTime() &&
    existing.updatedAt.getTime() === item.updatedAt.getTime();
  if (!currentItemMatches || ascendingExistingRevisions.length !== sortedRevisions.length) {
    return false;
  }
  return ascendingExistingRevisions.every((existingRevision, index) => {
    const importedRevision = sortedRevisions[index];
    if (!importedRevision) {
      return false;
    }
    return (
      existingRevision.id === importedRevision.id &&
      existingRevision.promptItemId === item.id &&
      existingRevision.revision === index + 1 &&
      existingRevision.title === normalizeTitle(importedRevision.title, importedRevision.content) &&
      existingRevision.content === importedRevision.content &&
      existingRevision.description === normalizedDescription &&
      comparable(existingRevision.tags) === comparable(normalizedTags) &&
      existingRevision.modelKey === (importedRevision.modelKey?.trim() || null) &&
      comparable(existingRevision.modelSettings) === comparable(importedRevision.modelSettings) &&
      existingRevision.note === (importedRevision.note?.trim() || null) &&
      existingRevision.createdAt.getTime() === importedRevision.createdAt.getTime()
    );
  });
}

async function insertImportedItem(
  tx: PromptItemDatabase,
  item: ImportPromptItem,
  normalizedTags: readonly string[],
  normalizedTitle: string,
  sortedRevisions: readonly ImportPromptItemRevision[]
): Promise<void> {
  await tx.query(
    `INSERT INTO prompt_items (
       id, kind, title, content, description, tags, is_favorite,
       source_url, rating, model_key, model_settings, revision,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10,
       $11::jsonb, $12, $13, $14
     )`,
    [
      item.id,
      item.kind,
      normalizedTitle,
      item.content,
      item.description?.trim() || null,
      JSON.stringify(normalizedTags),
      item.isFavorite,
      item.sourceUrl?.trim() || null,
      item.rating ?? null,
      item.modelKey?.trim() || null,
      toJson(item.modelSettings),
      sortedRevisions.length + 1,
      item.createdAt,
      item.updatedAt,
    ]
  );

  for (const [index, revision] of sortedRevisions.entries()) {
    await tx.query(
      `INSERT INTO prompt_item_revisions (
         id, prompt_item_id, revision, title, content, description,
         tags, model_key, model_settings, note, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11
       )`,
      [
        revision.id,
        item.id,
        index + 1,
        normalizeTitle(revision.title, revision.content),
        revision.content,
        item.description?.trim() || null,
        JSON.stringify(normalizedTags),
        revision.modelKey?.trim() || null,
        toJson(revision.modelSettings),
        revision.note?.trim() || null,
        revision.createdAt,
      ]
    );
  }
}

async function importSnapshotItem(
  tx: PromptItemDatabase,
  repository: PromptItemRepository,
  item: ImportPromptItem
): Promise<void> {
  const { normalizedTags, normalizedTitle, sortedRevisions } = prepareImportedItem(item);
  const existing = await repository.findById(item.id);
  if (!existing) {
    await insertImportedItem(tx, item, normalizedTags, normalizedTitle, sortedRevisions);
    return;
  }
  const existingRevisions = await repository.listRevisions(item.id);
  if (
    !importedItemMatches(
      existing,
      existingRevisions,
      item,
      normalizedTags,
      normalizedTitle,
      sortedRevisions
    )
  ) {
    throw new Error(`Legacy prompt "${item.id}" conflicts with an existing database record.`);
  }
}

function buildImportConflictGuards({
  item,
  normalizedTags,
  normalizedTitle,
  sortedRevisions,
}: PreparedImportPromptItem): TransactionStatement[] {
  const conflictMessage = `Legacy prompt "${item.id}" conflicts with an existing database record.`;
  const normalizedDescription = item.description?.trim() || null;
  const currentItemGuard: TransactionStatement = {
    expectedRowCount: 0,
    params: [
      item.id,
      item.kind,
      normalizedTitle,
      item.content,
      normalizedDescription,
      JSON.stringify(normalizedTags),
      item.isFavorite,
      item.sourceUrl?.trim() || null,
      item.rating ?? null,
      item.modelKey?.trim() || null,
      toJson(item.modelSettings),
      sortedRevisions.length + 1,
      item.createdAt.toISOString(),
      item.updatedAt.toISOString(),
    ],
    rowCountMismatchError: conflictMessage,
    sql: `SELECT prompt_item.id
          FROM prompt_items AS prompt_item
          WHERE prompt_item.id = $1
            AND NOT (
              prompt_item.kind = $2
              AND prompt_item.title = $3
              AND prompt_item.content = $4
              AND prompt_item.description IS NOT DISTINCT FROM $5::text
              AND prompt_item.tags = $6::jsonb
              AND prompt_item.is_favorite = $7
              AND prompt_item.source_url IS NOT DISTINCT FROM $8::text
              AND prompt_item.rating IS NOT DISTINCT FROM $9::integer
              AND prompt_item.model_key IS NOT DISTINCT FROM $10::text
              AND prompt_item.model_settings IS NOT DISTINCT FROM $11::jsonb
              AND prompt_item.revision = $12::integer
              AND prompt_item.created_at = $13::timestamptz
              AND prompt_item.updated_at = $14::timestamptz
            )`,
  };
  const revisionCountGuard: TransactionStatement = {
    expectedRowCount: 0,
    params: [item.id, sortedRevisions.length],
    rowCountMismatchError: conflictMessage,
    sql: `SELECT prompt_item.id
          FROM prompt_items AS prompt_item
          WHERE prompt_item.id = $1
            AND (
              SELECT COUNT(*)::integer
              FROM prompt_item_revisions AS revision_row
              WHERE revision_row.prompt_item_id = prompt_item.id
            ) <> $2::integer`,
  };
  const revisionGuards = sortedRevisions.map(
    (revision, index): TransactionStatement => ({
      expectedRowCount: 0,
      params: [
        item.id,
        revision.id,
        index + 1,
        normalizeTitle(revision.title, revision.content),
        revision.content,
        normalizedDescription,
        JSON.stringify(normalizedTags),
        revision.modelKey?.trim() || null,
        toJson(revision.modelSettings),
        revision.note?.trim() || null,
        revision.createdAt.toISOString(),
      ],
      rowCountMismatchError: conflictMessage,
      sql: `SELECT prompt_item.id
            FROM prompt_items AS prompt_item
            WHERE prompt_item.id = $1
              AND NOT EXISTS (
                SELECT 1
                FROM prompt_item_revisions AS revision_row
                WHERE revision_row.prompt_item_id = prompt_item.id
                  AND revision_row.id = $2
                  AND revision_row.revision = $3::integer
                  AND revision_row.title = $4
                  AND revision_row.content = $5
                  AND revision_row.description IS NOT DISTINCT FROM $6::text
                  AND revision_row.tags = $7::jsonb
                  AND revision_row.model_key IS NOT DISTINCT FROM $8::text
                  AND revision_row.model_settings IS NOT DISTINCT FROM $9::jsonb
                  AND revision_row.note IS NOT DISTINCT FROM $10::text
                  AND revision_row.created_at = $11::timestamptz
              )`,
    })
  );
  return [currentItemGuard, revisionCountGuard, ...revisionGuards];
}

function buildConditionalImportInsert({
  item,
  normalizedTags,
  normalizedTitle,
  sortedRevisions,
}: PreparedImportPromptItem): TransactionStatement {
  const params: unknown[] = [];
  const bind = (value: unknown, cast = ''): string => {
    params.push(value);
    return `$${params.length}${cast}`;
  };
  const itemValues = [
    bind(item.id),
    bind(item.kind),
    bind(normalizedTitle),
    bind(item.content),
    bind(item.description?.trim() || null),
    bind(JSON.stringify(normalizedTags), '::jsonb'),
    bind(item.isFavorite),
    bind(item.sourceUrl?.trim() || null),
    bind(item.rating ?? null),
    bind(item.modelKey?.trim() || null),
    bind(toJson(item.modelSettings), '::jsonb'),
    bind(sortedRevisions.length + 1),
    bind(item.createdAt.toISOString()),
    bind(item.updatedAt.toISOString()),
  ];
  const revisionRows = sortedRevisions.map((revision, index) => {
    const values = [
      bind(revision.id),
      bind(index + 1, '::integer'),
      bind(normalizeTitle(revision.title, revision.content)),
      bind(revision.content),
      bind(item.description?.trim() || null),
      bind(JSON.stringify(normalizedTags), '::jsonb'),
      bind(revision.modelKey?.trim() || null),
      bind(toJson(revision.modelSettings), '::jsonb'),
      bind(revision.note?.trim() || null),
      bind(revision.createdAt.toISOString(), '::timestamptz'),
    ];
    return `(${values.join(', ')})`;
  });
  const revisionInsert =
    revisionRows.length === 0
      ? ''
      : `,
         inserted_revisions AS (
           INSERT INTO prompt_item_revisions (
             id, prompt_item_id, revision, title, content, description,
             tags, model_key, model_settings, note, created_at
           )
           SELECT
             imported_revision.id,
             inserted_item.id,
             imported_revision.revision,
             imported_revision.title,
             imported_revision.content,
             imported_revision.description,
             imported_revision.tags,
             imported_revision.model_key,
             imported_revision.model_settings,
             imported_revision.note,
             imported_revision.created_at
           FROM inserted_item
           CROSS JOIN (
             VALUES ${revisionRows.join(',\n                    ')}
           ) AS imported_revision (
             id, revision, title, content, description, tags,
             model_key, model_settings, note, created_at
           )
           RETURNING id
         )`;

  return {
    params,
    sql: `WITH inserted_item AS (
            INSERT INTO prompt_items (
              id, kind, title, content, description, tags, is_favorite,
              source_url, rating, model_key, model_settings, revision,
              created_at, updated_at
            ) VALUES (${itemValues.join(', ')})
            ON CONFLICT (id) DO NOTHING
            RETURNING id
          )${revisionInsert}
          SELECT id FROM inserted_item`,
  };
}

function buildAtomicImportStatements(snapshot: PromptItemImportSnapshot): TransactionStatement[] {
  const preparedItems = snapshot.items.map(prepareImportedItem);
  return preparedItems.flatMap((item) => [
    ...buildImportConflictGuards(item),
    buildConditionalImportInsert(item),
  ]);
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

  async importSnapshot(snapshot: PromptItemImportSnapshot): Promise<void> {
    if (this.db.transaction) {
      await this.db.transaction(async (tx) => {
        const transactionalRepository = new PromptItemRepository(tx);
        for (const item of snapshot.items) {
          await importSnapshotItem(tx, transactionalRepository, item);
        }
      });
      return;
    }
    if (this.db.runTransaction) {
      const statements = buildAtomicImportStatements(snapshot);
      if (statements.length === 0) {
        return;
      }
      await this.db.runTransaction(statements, statements.length - 1);
      return;
    }
    throw new Error('Legacy prompt import requires an atomic database transaction.');
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
      params.push(`%${search}%`);
      where.push(
        `(title ILIKE $${params.length} OR content ILIKE $${params.length} OR description ILIKE $${params.length})`
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
