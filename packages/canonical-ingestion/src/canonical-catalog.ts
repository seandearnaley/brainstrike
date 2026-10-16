// The canonical catalog over the authoritative source catalog (SourceCatalogPort): desktop's native index and the
// browser's index worker (BST-1940) scan through the same owner.

import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import type { SourceCatalogPort, SourceCatalogRecord } from '@brainstrike/state-store';
import { sha256Hex } from '@brainstrike/utils/crypto';
import { Schema } from 'effect';
import type {
  CanonicalCatalogFile,
  CanonicalCatalogPort,
  CanonicalDiscoveredSourceFile,
  CanonicalFileIdentity,
  CanonicalManifestFile,
  CanonicalOperationContext,
  CanonicalSourceScope,
  CanonicalSourceStat,
} from './ports.js';

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
export const decodeNativeCanonicalCatalogRecords = makeThrowingDecoder(Schema.Array(recordSchema));
const decodeStat = makeThrowingDecoder(statSchema);
export type NativeCanonicalCatalogRecord = typeof recordSchema.Type;
export interface NativeCanonicalCatalogScope {
  /** Throws when the grant, saved collection choice, generation or reset lease is stale. */
  assertCurrent(): void;
  /** Validate the exact securely-read discovery against this same mounted main-owned grant. */
  assertDiscoveredSource(file: CanonicalDiscoveredSourceFile): void;
  /** The saved collection, or null for the TEXT partition, which has workspace scopes only. */
  readonly embeddingSetId: string | null;
  /** Main-owned catalog/grant projection; the utility path never establishes authority. */
  resolveIdentity(record: NativeCanonicalCatalogRecord): CanonicalFileIdentity;
}
export interface NativeCanonicalCatalogDependencies<Profile> {
  readonly catalog: SourceCatalogPort;
  /** Join the actual coordinator/native removal acknowledgment before canonical invalidation. */
  joinNativeRemoval(
    files: readonly CanonicalFileIdentity[],
    scope: CanonicalSourceScope,
    context: CanonicalOperationContext
  ): Promise<void>;
  /** Reload FULL canonical inventory and await owner-only trusted native binding replacement. */
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
  if (sha256Hex(content) !== contentHash) {
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
    throw new Error('Authoritative identity does not match canonical metadata.');
  }
  return identity;
}
function assertIdentity(actual: CanonicalFileIdentity, expected: CanonicalFileIdentity): void {
  if (identityFields.some((field) => actual[field] !== expected[field])) {
    throw new Error('Canonical identity does not match the authorized binding.');
  }
}
async function loadRecords(
  catalog: SourceCatalogPort,
  files: readonly { readonly fileId: string }[],
  maxContentBytes?: number
): Promise<readonly SourceCatalogRecord[]> {
  assertBatch(files);
  const result = await catalog.sourceCatalog({
    fileIds: files.map((file) => file.fileId),
    operation: 'read',
    ...(maxContentBytes === undefined ? {} : { maxContentBytes }),
  });
  decodeNativeCanonicalCatalogRecords(result.files);
  const byId = new Map(result.files.map((file) => [file.fileId, file]));
  if (result.files.length !== files.length || byId.size !== result.files.length) {
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
/** All admitted writer and binding promises settle before cancellation returns. */
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
      (authority.embeddingSetId !== null && !authority.embeddingSetId.trim()) ||
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
      const records = await loadRecords(
        dependencies.catalog,
        request.files,
        Math.max(0, ...request.files.map((file) => Buffer.byteLength(file.content)))
      );
      checkCurrent(authority, context);
      const files = records.map((record, index) => {
        const file = request.files[index];
        if (!file) {
          throw new Error('Canonical source is missing.');
        }
        assertIdentity(identityFor(record, request.scope, authority), file);
        if (
          record.rootId === null &&
          (record.content !== file.content || record.contentHash !== file.contentHash)
        ) {
          throw new Error('Original retained source changed during collection ingestion.');
        }
        return {
          expected: record,
          source: {
            content: file.content,
            contentHash: file.contentHash,
            fileName: record.fileName,
            path: record.path,
            stat: file.stat,
          },
        };
      });
      await dependencies.catalog.sourceCatalog({ files, operation: 'replace' });
      checkCurrent(authority, context);
      await acknowledge(request.scope, authority, context);
    },
    async completeFiles(request, context) {
      assertBatch(request.files);
      const authority = await authorize(request.scope, context);
      const records = await loadRecords(dependencies.catalog, request.files);
      checkCurrent(authority, context);
      const files = records.map((record, index) => {
        identityFor(record, request.scope, authority);
        const file = request.files[index];
        if (!file || record.contentHash !== file.contentHash) {
          throw new Error('Canonical completion hash is stale.');
        }
        if (!Number.isSafeInteger(file.chunkCount) || file.chunkCount < 0) {
          throw new Error('Canonical completion requires a nonnegative chunk count.');
        }
        return { chunkCount: file.chunkCount, expected: record };
      });
      await dependencies.catalog.sourceCatalog({ files, operation: 'complete' });
      checkCurrent(authority, context);
    },
    async loadAuthorizedBatch(request, context) {
      const authority = await authorize(request.scope, context);
      const records = await loadRecords(dependencies.catalog, request.files);
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
      const current = await loadRecords(dependencies.catalog, request.files);
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
      checkCurrent(authority, context);
      const result = await dependencies.catalog.sourceCatalog({
        embeddingSetId: authority.embeddingSetId,
        files: request.files.map((file) => ({
          content: file.content,
          contentHash: file.contentHash,
          fileName: file.fileName,
          path: file.relativePath,
          stat: file.stat,
        })),
        operation: 'prepare',
        rootId: request.scope.rootId,
      });
      checkCurrent(authority, context);
      if (result.files.length !== request.files.length) {
        throw new Error('Canonical preparation returned an incomplete batch.');
      }
      const prepared = result.files.map((record, index): CanonicalManifestFile => {
        const source = request.files[index];
        if (
          !source ||
          record.contentHash !== source.contentHash ||
          record.path !== source.relativePath
        ) {
          throw new Error('Canonical prepared source hash or path is stale.');
        }
        const identity = identityFor(record, request.scope, authority);
        assertIdentity(identity, {
          embeddingSetId: authority.embeddingSetId,
          fileId: record.fileId,
          fileName: source.fileName,
          relativePath: source.relativePath,
          rootId: source.rootId,
          sourcePath: source.sourcePath,
        });
        return { ...identity, contentHash: source.contentHash };
      });
      await acknowledge(request.scope, authority, context);
      const current = await loadRecords(dependencies.catalog, prepared);
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
      const [record] = await loadRecords(dependencies.catalog, [file], maxFileBytes);
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
      const initial = await loadRecords(dependencies.catalog, request.files);
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
      const records = await loadRecords(dependencies.catalog, request.files);
      checkCurrent(authority, context);
      assertRemovalRecords(records, initial, request.files, request.scope, authority);
      await dependencies.catalog.sourceCatalog({ files: records, operation: 'remove' });
      checkCurrent(authority, context);
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
