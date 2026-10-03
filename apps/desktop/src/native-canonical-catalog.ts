import { createHash, randomUUID } from 'node:crypto';
import type {
  CanonicalCatalogFile,
  CanonicalCatalogPort,
  CanonicalDiscoveredSourceFile,
  CanonicalFileIdentity,
  CanonicalManifestFile,
  CanonicalOperationContext,
  CanonicalSourceScope,
  CanonicalSourceStat,
} from '@brainstrike/canonical-ingestion';
import {
  applyManagedCacheBatch,
  FileRecordRepository,
  type IDatabase,
  invalidateManagedCacheEntriesByIdentity,
  type ManagedCacheBatchMutation,
} from '@brainstrike/db';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';

const nullableText = Schema.NullOr(Schema.String);
const statSchema = Schema.Struct({
  mtimeMs: Schema.NullOr(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
  size: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
const recordSchema = Schema.Struct({
  chunksProcessed: Schema.Boolean,
  content: nullableText,
  contentHash: nullableText,
  embeddingSetId: nullableText,
  fileId: Schema.NonEmptyString,
  fileName: Schema.NonEmptyString,
  path: nullableText,
  rootId: nullableText,
  stat: statSchema,
});
const decodeRecords = makeThrowingDecoder(Schema.Array(recordSchema));
const decodeStat = makeThrowingDecoder(statSchema);
const decodeReturned = makeThrowingDecoder(Schema.Array(Schema.Struct({ fileId: Schema.String })));
const decodeRoots = makeThrowingDecoder(Schema.Array(Schema.Struct({ id: Schema.String })));
export type NativeCanonicalCatalogRecord = typeof recordSchema.Type;
export interface NativeCanonicalCatalogScope {
  /** Throws when the grant, saved collection choice, generation or reset lease is stale. */
  assertCurrent(): void;
  /** Validate the exact securely-read discovery against this same mounted main-owned grant. */
  assertDiscoveredSource(file: CanonicalDiscoveredSourceFile): void;
  readonly embeddingSetId: string;
  /** Main-owned PG/grant projection; the utility path never establishes authority. */
  resolveIdentity(record: NativeCanonicalCatalogRecord): CanonicalFileIdentity;
}
export interface NativeCanonicalCatalogDependencies<Profile> {
  readonly database: IDatabase & Required<Pick<IDatabase, 'transaction'>>;
  /** Join the actual coordinator/native removal acknowledgment before PG invalidation. */
  joinNativeRemoval(
    files: readonly CanonicalFileIdentity[],
    scope: CanonicalSourceScope,
    context: CanonicalOperationContext
  ): Promise<void>;
  /** Reload FULL PG inventory and await owner-only trusted native binding replacement. */
  replaceTrustedBindings(
    scope: CanonicalSourceScope,
    context: CanonicalOperationContext
  ): Promise<void>;
  resolveProfile(
    scope: CanonicalSourceScope,
    authority: NativeCanonicalCatalogScope,
    context: CanonicalOperationContext
  ): Promise<Profile>;
  resolveScope(
    scope: CanonicalSourceScope,
    context: CanonicalOperationContext
  ): Promise<NativeCanonicalCatalogScope>;
}
const identityFields = [
  'embeddingSetId',
  'fileId',
  'fileName',
  'relativePath',
  'rootId',
  'sourcePath',
] as const;
const projection = `id::text AS "fileId", name AS "fileName", path, root_id AS "rootId",
  embedding_set_id::text AS "embeddingSetId", content_hash AS "contentHash",
  (chunks_processed_at IS NOT NULL) AS "chunksProcessed",
  json_build_object('mtimeMs', mtime_ms, 'size', size) AS stat`;
const metadataGuard = `id::text = $1 AND embedding_set_id::text IS NOT DISTINCT FROM $2
  AND root_id IS NOT DISTINCT FROM $3 AND path IS NOT DISTINCT FROM $4
  AND name = $5 AND content_hash IS NOT DISTINCT FROM $6`;
function checkCurrent(
  authority: NativeCanonicalCatalogScope,
  context: CanonicalOperationContext
): void {
  context.signal.throwIfAborted();
  authority.assertCurrent();
}
function assertBatch(files: readonly { readonly fileId: string }[]): void {
  if (files.length > 250) {
    throw new Error('Canonical catalog batch exceeds 250 files.');
  }
  const ids = new Set<string>();
  for (const file of files) {
    if (!file.fileId.trim() || ids.has(file.fileId)) {
      throw new Error('Canonical catalog has a blank or duplicate identity.');
    }
    ids.add(file.fileId);
  }
}
function assertDiscoveryBatch(
  files: readonly CanonicalDiscoveredSourceFile[],
  scope: Extract<CanonicalSourceScope, { readonly kind: 'workspace' }>,
  authority: NativeCanonicalCatalogScope
): void {
  if (files.length > 250) {
    throw new Error('Canonical discovery batch exceeds 250 files.');
  }
  const paths = new Set<string>();
  for (const file of files) {
    if (
      file.rootId !== scope.rootId ||
      !file.fileName.trim() ||
      !file.sourcePath.trim() ||
      !file.relativePath.trim() ||
      paths.has(file.relativePath)
    ) {
      throw new Error('Canonical discovery has a foreign or duplicate source identity.');
    }
    paths.add(file.relativePath);
    decodeStat(file.stat);
    authority.assertDiscoveredSource(file);
  }
}
function assertHash(content: string, contentHash: string): void {
  if (createHash('sha256').update(content).digest('hex') !== contentHash) {
    throw new Error('Canonical source hash does not match original content.');
  }
}
function identityFor(
  record: NativeCanonicalCatalogRecord,
  scope: CanonicalSourceScope,
  authority: NativeCanonicalCatalogScope
): CanonicalFileIdentity {
  if (
    record.embeddingSetId !== authority.embeddingSetId ||
    (scope.kind === 'workspace' && record.rootId !== scope.rootId)
  ) {
    throw new Error('Canonical identity is outside the authorized scope.');
  }
  const identity = authority.resolveIdentity(record);
  if (
    identity.fileId !== record.fileId ||
    identity.fileName !== record.fileName ||
    identity.embeddingSetId !== record.embeddingSetId ||
    identity.rootId !== record.rootId ||
    (identity.relativePath !== null && identity.relativePath !== record.path) ||
    (scope.kind === 'workspace' && identity.relativePath !== record.path)
  ) {
    throw new Error('Authoritative identity does not match PG metadata.');
  }
  return identity;
}
function assertIdentity(actual: CanonicalFileIdentity, expected: CanonicalFileIdentity): void {
  if (identityFields.some((field) => actual[field] !== expected[field])) {
    throw new Error('Canonical identity does not match the authorized binding.');
  }
}
function assertReturned(rows: readonly unknown[], fileId: string): void {
  const returned = decodeReturned(rows);
  if (returned.length !== 1 || returned[0]?.fileId !== fileId) {
    throw new Error('Canonical mutation rejected stale metadata.');
  }
}
async function loadRecords(
  db: IDatabase,
  files: readonly { readonly fileId: string }[],
  locked = false,
  maxContentBytes?: number
): Promise<readonly NativeCanonicalCatalogRecord[]> {
  assertBatch(files);
  if (files.length === 0) {
    return [];
  }
  const contentProjection =
    maxContentBytes === undefined
      ? 'NULL::text AS content'
      : 'CASE WHEN octet_length(content)::bigint <= $2::bigint THEN content ELSE NULL END AS content';
  const columns = `${projection}, ${contentProjection}`;
  const params: unknown[] = [files.map((file) => file.fileId)];
  if (maxContentBytes !== undefined) {
    params.push(maxContentBytes);
  }
  const result = await db.query(
    `SELECT ${columns} FROM file_records WHERE id::text = ANY($1::text[])${locked ? ' FOR UPDATE' : ''}`,
    params
  );
  const rows = decodeRecords(result.rows);
  const byId = new Map(rows.map((row) => [row.fileId, row]));
  if (rows.length !== files.length || byId.size !== rows.length) {
    throw new Error('Canonical catalog has missing or duplicate identities.');
  }
  return files.map((file) => {
    const record = byId.get(file.fileId);
    if (!record) {
      throw new Error('Canonical identity is missing.');
    }
    return record;
  });
}
function guardedParameters(record: NativeCanonicalCatalogRecord): unknown[] {
  return [
    record.fileId,
    record.embeddingSetId,
    record.rootId,
    record.path,
    record.fileName,
    record.contentHash,
  ];
}
function assertRemovalRecords(
  records: readonly NativeCanonicalCatalogRecord[],
  initial: readonly NativeCanonicalCatalogRecord[],
  files: readonly CanonicalFileIdentity[],
  scope: CanonicalSourceScope,
  authority: NativeCanonicalCatalogScope
): void {
  records.forEach((record, index) => {
    const file = files[index];
    const expected = initial[index];
    if (!(file && expected) || record.contentHash !== expected.contentHash) {
      throw new Error('Canonical removal source is stale.');
    }
    assertIdentity(identityFor(record, scope, authority), file);
  });
}
/** Existing managed-cache policies share the caller's transaction, never a nested transaction. */
function transactionView(tx: IDatabase): IDatabase & Required<Pick<IDatabase, 'transaction'>> {
  return { query: tx.query.bind(tx), transaction: async (run) => await run(tx) };
}
/** All admitted PG and binding promises settle before cancellation returns. */
export function createNativeCanonicalCatalog<Profile>(
  dependencies: NativeCanonicalCatalogDependencies<Profile>
): CanonicalCatalogPort<Profile> & {
  readRetainedSource(
    file: CanonicalFileIdentity,
    maxFileBytes: number,
    scope: CanonicalSourceScope,
    context: CanonicalOperationContext
  ): Promise<{ readonly content: string; readonly stat: CanonicalSourceStat }>;
} {
  async function authorize(
    scope: CanonicalSourceScope,
    context: CanonicalOperationContext
  ): Promise<NativeCanonicalCatalogScope> {
    context.signal.throwIfAborted();
    if (
      !(
        context.requestId.trim() &&
        (scope.kind === 'workspace' ? scope.rootId : scope.embeddingSetId).trim()
      )
    ) {
      throw new Error('Canonical catalog requires a nonblank request and scope identity.');
    }
    const authority = await dependencies.resolveScope(scope, context);
    checkCurrent(authority, context);
    if (
      !authority.embeddingSetId.trim() ||
      (scope.kind === 'collection' && authority.embeddingSetId !== scope.embeddingSetId)
    ) {
      throw new Error('Canonical collection membership does not match scope authority.');
    }
    return authority;
  }
  async function acknowledge(
    scope: CanonicalSourceScope,
    authority: NativeCanonicalCatalogScope,
    context: CanonicalOperationContext
  ): Promise<void> {
    checkCurrent(authority, context);
    await dependencies.replaceTrustedBindings(scope, context);
    checkCurrent(authority, context);
  }
  return {
    async applyManagedCacheBatch(request, context) {
      assertBatch(request.files);
      for (const file of request.files) {
        assertHash(file.content, file.contentHash);
        decodeStat(file.stat);
      }
      const authority = await authorize(request.scope, context);
      await dependencies.database.transaction(async (tx) => {
        checkCurrent(authority, context);
        const records = await loadRecords(
          tx,
          request.files,
          true,
          Math.max(0, ...request.files.map((file) => Buffer.byteLength(file.content)))
        );
        checkCurrent(authority, context);
        const changes: ManagedCacheBatchMutation[] = [];
        const now = new Date().toISOString();
        for (const [index, record] of records.entries()) {
          const file = request.files[index];
          if (!file) {
            throw new Error('Canonical source is missing.');
          }
          assertIdentity(identityFor(record, request.scope, authority), file);
          if (
            record.rootId === null &&
            (record.content !== file.content ||
              (record.contentHash !== null && record.contentHash !== file.contentHash))
          ) {
            throw new Error('Original retained source changed during collection ingestion.');
          }
          if (record.path === null) {
            throw new Error('Managed source requires its real PG path.');
          }
          changes.push({
            mode: 'replace',
            record: {
              content: file.content,
              contentHash: file.contentHash,
              id: record.fileId,
              mtimeMs: file.stat.mtimeMs,
              name: record.fileName,
              path: record.path,
              processedAt: now,
              size: file.stat.size,
              tokenCount: Math.ceil(file.content.length / 4),
              updatedAt: now,
            },
          });
        }
        // Explicitly reuse the existing outer transaction, without assuming nested tx support.
        await applyManagedCacheBatch(transactionView(tx), {
          changes,
          embeddingSetId: authority.embeddingSetId,
        });
        checkCurrent(authority, context);
      });
      await acknowledge(request.scope, authority, context);
    },
    async completeFiles(request, context) {
      assertBatch(request.files);
      const authority = await authorize(request.scope, context);
      await dependencies.database.transaction(async (tx) => {
        checkCurrent(authority, context);
        const records = await loadRecords(tx, request.files, true);
        checkCurrent(authority, context);
        for (const [index, record] of records.entries()) {
          identityFor(record, request.scope, authority);
          const file = request.files[index];
          if (!file || record.contentHash !== file.contentHash) {
            throw new Error('Canonical completion hash is stale.');
          }
          if (!Number.isSafeInteger(file.chunkCount) || file.chunkCount < 0) {
            throw new Error('Canonical completion requires a nonnegative chunk count.');
          }
          const result = await tx.query(
            `UPDATE file_records SET chunks_count = $7, chunks_processed_at = $8 WHERE ${metadataGuard} RETURNING id::text AS "fileId"`,
            [...guardedParameters(record), file.chunkCount, new Date().toISOString()]
          );
          assertReturned(result.rows, record.fileId);
          checkCurrent(authority, context);
        }
      });
      checkCurrent(authority, context);
    },
    async loadAuthorizedBatch(request, context) {
      const authority = await authorize(request.scope, context);
      const records = await loadRecords(dependencies.database, request.files);
      checkCurrent(authority, context);
      const files = records.map((record, index): CanonicalCatalogFile => {
        const identity = identityFor(record, request.scope, authority);
        const expected = request.files[index];
        if (!expected) {
          throw new Error('Canonical identity is missing.');
        }
        assertIdentity(identity, expected);
        return {
          ...identity,
          chunksProcessed: record.chunksProcessed,
          contentHash: record.contentHash,
          stat: record.stat,
        };
      });
      await acknowledge(request.scope, authority, context);
      const current = await loadRecords(dependencies.database, request.files);
      checkCurrent(authority, context);
      return current.map((record, index): CanonicalCatalogFile => {
        const expected = files[index];
        if (!expected) {
          throw new Error('Canonical identity is missing after binding acknowledgement.');
        }
        const identity = identityFor(record, request.scope, authority);
        assertIdentity(identity, expected);
        return {
          ...identity,
          chunksProcessed: record.chunksProcessed,
          contentHash: record.contentHash,
          stat: record.stat,
        };
      });
    },
    async prepareManagedSourcesBatch(request, context) {
      const authority = await authorize(request.scope, context);
      assertDiscoveryBatch(request.files, request.scope, authority);
      for (const file of request.files) {
        assertHash(file.content, file.contentHash);
      }
      const prepared = await dependencies.database.transaction(async (tx) => {
        checkCurrent(authority, context);
        // Existing PG root ownership serializes identity allocation for this root.
        const roots = await tx.query(
          'SELECT id FROM roots WHERE id = $1 AND status = $2 FOR UPDATE',
          [request.scope.rootId, 'live']
        );
        const rootRows = decodeRoots(roots.rows);
        if (rootRows.length !== 1 || rootRows[0]?.id !== request.scope.rootId) {
          throw new Error('Canonical discovery root is absent or revoked.');
        }
        checkCurrent(authority, context);
        const repository = new FileRecordRepository(tx);
        const changes: ManagedCacheBatchMutation[] = [];
        const identities: CanonicalFileIdentity[] = [];
        const now = new Date().toISOString();
        for (const file of request.files) {
          const existing = await repository.findByManagedCacheIdentity(
            authority.embeddingSetId,
            request.scope.rootId,
            file.relativePath
          );
          checkCurrent(authority, context);
          const fileId = existing === null ? randomUUID() : existing.id;
          identities.push({
            embeddingSetId: authority.embeddingSetId,
            fileId,
            fileName: file.fileName,
            relativePath: file.relativePath,
            rootId: file.rootId,
            sourcePath: file.sourcePath,
          });
          const record = {
            content: file.content,
            contentHash: file.contentHash,
            id: fileId,
            mtimeMs: file.stat.mtimeMs,
            name: file.fileName,
            path: file.relativePath,
            processedAt: now,
            size: file.stat.size,
            tokenCount: Math.ceil(file.content.length / 4),
            updatedAt: now,
          };
          changes.push(
            existing === null
              ? { mode: 'import', record: { ...record, createdAt: now } }
              : { mode: 'replace', record }
          );
        }
        assertBatch(identities);
        await applyManagedCacheBatch(transactionView(tx), {
          changes,
          embeddingSetId: authority.embeddingSetId,
          rootId: request.scope.rootId,
        });
        checkCurrent(authority, context);
        const records = await loadRecords(tx, identities);
        checkCurrent(authority, context);
        return records.map((record, index): CanonicalManifestFile => {
          const identity = identities[index];
          const source = request.files[index];
          if (!(identity && source) || record.contentHash !== source.contentHash) {
            throw new Error('Canonical prepared source hash is stale.');
          }
          assertIdentity(identityFor(record, request.scope, authority), identity);
          return { ...identity, contentHash: source.contentHash };
        });
      });
      await acknowledge(request.scope, authority, context);
      const current = await loadRecords(dependencies.database, prepared);
      checkCurrent(authority, context);
      current.forEach((record, index) => {
        const expected = prepared[index];
        if (!expected || record.contentHash !== expected.contentHash) {
          throw new Error('Canonical prepared source hash is stale after binding acknowledgement.');
        }
        assertIdentity(identityFor(record, request.scope, authority), expected);
      });
      return prepared;
    },
    async readRetainedSource(file, maxFileBytes, scope, context) {
      if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
        throw new Error('Retained source requires a positive byte bound.');
      }
      const authority = await authorize(scope, context);
      const [record] = await loadRecords(dependencies.database, [file], false, maxFileBytes);
      checkCurrent(authority, context);
      if (!record) {
        throw new Error('Retained source identity is missing.');
      }
      assertIdentity(identityFor(record, scope, authority), file);
      if (record.content === null || Buffer.byteLength(record.content) > maxFileBytes) {
        throw new Error('Original retained source is absent or exceeds the byte bound.');
      }
      if (record.contentHash !== null) {
        assertHash(record.content, record.contentHash);
      }
      return { content: record.content, stat: record.stat };
    },
    async removeFiles(request, context) {
      const authority = await authorize(request.scope, context);
      const initial = await loadRecords(dependencies.database, request.files);
      checkCurrent(authority, context);
      initial.forEach((record, index) => {
        const file = request.files[index];
        if (!file) {
          throw new Error('Canonical removal identity is missing.');
        }
        assertIdentity(identityFor(record, request.scope, authority), file);
      });
      await dependencies.joinNativeRemoval(request.files, request.scope, context);
      checkCurrent(authority, context);
      await dependencies.database.transaction(async (tx) => {
        const records = await loadRecords(tx, request.files, true);
        checkCurrent(authority, context);
        assertRemovalRecords(records, initial, request.files, request.scope, authority);
        const targets = records.map((record) =>
          record.rootId !== null && record.path !== null
            ? {
                expectedFileRecordId: record.fileId,
                relativePath: record.path,
                rootId: record.rootId,
              }
            : {
                expectedFileRecordId: record.fileId,
                mode: 'record' as const,
                relativePath: record.path,
                rootId: record.rootId,
              }
        );
        if (targets.length > 0) {
          const result = await invalidateManagedCacheEntriesByIdentity(transactionView(tx), {
            embeddingSetId: authority.embeddingSetId,
            targets,
          });
          const deleted = new Set(result.deletedFileRecordIds);
          if (
            deleted.size !== targets.length ||
            targets.some((target) => !deleted.has(target.expectedFileRecordId))
          ) {
            throw new Error('Canonical invalidation rejected stale identity.');
          }
          checkCurrent(authority, context);
        }
      });
      await acknowledge(request.scope, authority, context);
    },
    async resolveProfile(request, context) {
      const authority = await authorize(request.scope, context);
      const profile = await dependencies.resolveProfile(request.scope, authority, context);
      checkCurrent(authority, context);
      return profile;
    },
  };
}
