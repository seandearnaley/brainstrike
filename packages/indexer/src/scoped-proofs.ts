import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { validateSnapshot } from './chunks.js';
import {
  decoder,
  IndexerError,
  type IndexFileBinding,
  type IndexScope,
  type ScopedCoverage,
  type ScopedManifestFile,
  type ScopedManifestResult,
  scopedCoverageBatchRequestSchema,
  scopedCoverageRequestSchema,
  scopedCoverageSchema,
  scopedManifestChunkSchema,
  scopedManifestFileSchema,
  scopedManifestRequestSchema,
  scopedManifestResultSchema,
} from './contracts.js';
import { compareManifest } from './index-manifest.js';
import { readScopedIdentity } from './index-metadata.js';
import { type ScopeAuthority, vectorProfileHash } from './scope-authority.js';
import { validateScopedStorage } from './scoped-vector-validation.js';

function scopePredicate(scope: IndexScope): { predicate: string; value: string } {
  return scope.kind === 'workspace'
    ? { predicate: 'f.root_id=?', value: scope.rootId }
    : { predicate: 'f.embedding_set_id=?', value: scope.embeddingSetId };
}
function declaredManifest(
  authority: ScopeAuthority,
  scope: IndexScope,
  files: readonly ScopedManifestFile[]
): Map<string, ScopedManifestFile> {
  const expected = new Map<string, ScopedManifestFile>();
  const paths = new Set<string>();
  for (const file of files) {
    authority.file(file.fileId, scope);
    authority.snapshot({ ...file, chunkLines: 1, content: '' }, null);
    validateSnapshot({ ...file, chunkLines: 1, content: '' });
    const key = JSON.stringify([file.rootId, file.relativePath]);
    if (
      expected.has(file.fileId) ||
      (file.rootId !== null && paths.has(key)) ||
      new Set(file.chunks.map((chunk) => chunk.chunkId)).size !== file.chunks.length
    ) {
      throw new TypeError(
        'Canonical scoped manifests require unique file, workspace-path and per-file chunk identities.'
      );
    }
    expected.set(file.fileId, file);
    if (file.rootId !== null) {
      paths.add(key);
    }
  }
  if (expected.size !== authority.selectedFiles([scope]).length) {
    throw new IndexerError(
      'incomplete-manifest',
      'A scoped manifest must declare the complete current canonical file inventory.'
    );
  }
  return expected;
}
function actualManifest(db: Database.Database, scope: IndexScope): ScopedManifestFile[] {
  const { predicate, value } = scopePredicate(scope);
  const files = decoder(
    Schema.Array(
      Schema.Struct({
        ...scopedManifestFileSchema.fields,
        chunks: Schema.optional(scopedManifestFileSchema.fields.chunks),
      })
    )
  )(
    db
      .prepare(
        `SELECT f.id AS fileId,f.root_id AS rootId,f.path AS relativePath,f.embedding_set_id AS embeddingSetId,f.source_path AS sourcePath,f.content_hash AS contentHash FROM file_records f WHERE ${predicate} ORDER BY f.id`
      )
      .all(value)
  );
  const chunks = decoder(
    Schema.Array(Schema.Struct({ ...scopedManifestChunkSchema.fields, fileId: Schema.String }))
  )(
    db
      .prepare(
        `SELECT c.id AS chunkId,c.file_record_id AS fileId,c.content_hash AS contentHash,c.start_line AS startLine,c.end_line AS endLine,c.chunk_index AS chunkIndex,c.chunk_size AS chunkSize,c.chunk_type AS chunkType,c.start_offset AS startOffset,c.end_offset AS endOffset,c.token_count AS tokenCount FROM file_chunks c JOIN file_records f ON f.id=c.file_record_id WHERE ${predicate} ORDER BY c.id`
      )
      .all(value)
  );
  const grouped = new Map<string, ScopedManifestFile['chunks'][number][]>();
  for (const { fileId, ...chunk } of chunks) {
    const list = grouped.get(fileId) ?? [];
    list.push(chunk);
    grouped.set(fileId, list);
  }
  return files.map((file) => ({ ...file, chunks: grouped.get(file.fileId) ?? [] }));
}
function manifestDiffers(expected: ScopedManifestFile, stored: ScopedManifestFile): boolean {
  for (const key of [
    'rootId',
    'relativePath',
    'embeddingSetId',
    'sourcePath',
    'contentHash',
  ] as const) {
    if (expected[key] !== stored[key]) {
      return true;
    }
  }
  const ordered = (file: ScopedManifestFile): string =>
    JSON.stringify([...file.chunks].sort((a, b) => a.chunkId.localeCompare(b.chunkId)));
  return ordered(expected) !== ordered(stored);
}
/** Exact current source inventory only; the existing main receipt owner publishes readiness. */
export function verifyScopedManifest(
  db: Database.Database,
  authority: ScopeAuthority,
  input: unknown
): ScopedManifestResult {
  const request = decoder(scopedManifestRequestSchema)(input);
  authority.authorize([request.scope]);
  const expected = declaredManifest(authority, request.scope, request.files);
  return db.transaction(() =>
    decoder(scopedManifestResultSchema)({
      ...readScopedIdentity(db, authority.revision),
      ...compareManifest(expected, actualManifest(db, request.scope), manifestDiffers),
      scope: request.scope,
    })
  )();
}
function selectedCounts(
  db: Database.Database,
  scope: IndexScope,
  selected: readonly IndexFileBinding[],
  profileHash: string | null
): ScopedCoverage['counts'] {
  const { predicate, value } = scopePredicate(scope);
  const files = JSON.stringify(selected.map((file) => file.fileId));
  const counts = decoder(
    Schema.Struct({ chunks: Schema.Int, indexedFiles: Schema.Int, vectors: Schema.Int })
  )(
    db
      .prepare(
        `SELECT count(DISTINCT f.id) AS indexedFiles,count(c.pk) AS chunks,count(v.pk) AS vectors FROM file_records f LEFT JOIN file_chunks c ON c.file_record_id=f.id LEFT JOIN scoped_vectors v ON v.chunk_pk=c.pk AND v.profile_hash=? WHERE ${predicate} AND f.id IN (SELECT value FROM json_each(?))`
      )
      .get(profileHash, value, files)
  );
  return { ...counts, missingVectors: counts.chunks - counts.vectors };
}
export function scopeCoverage(
  db: Database.Database,
  authority: ScopeAuthority,
  input: unknown
): ScopedCoverage {
  const [result] = scopeCoverageBatch(db, authority, [decoder(scopedCoverageRequestSchema)(input)]);
  if (!result) {
    throw new Error('Native singleton coverage returned no result.');
  }
  return result;
}
/** Validation sharing ends with this owned read transaction; never cache across observations. */
export function scopeCoverageBatch(
  db: Database.Database,
  authority: ScopeAuthority,
  input: unknown,
  expected?: {
    readonly storeId: string;
    readonly authorityEpoch: string;
    readonly authorityRevision: number;
  }
): readonly ScopedCoverage[] {
  const requests = decoder(scopedCoverageBatchRequestSchema)(input).map((request) => {
    authority.authorize([request.scope]);
    const selected = authority.selectedFiles([request.scope]);
    const profile = request.profile ?? null;
    const profileHash = profile ? vectorProfileHash(profile) : null;
    if (
      profileHash &&
      selected.some((file) => !file.profile || vectorProfileHash(file.profile) !== profileHash)
    ) {
      throw new IndexerError(
        'profile-not-authorized',
        'Coverage profile differs from the current canonical selection.'
      );
    }
    return { profile, profileHash, request, selected };
  });
  return db.transaction(() => {
    const identity = readScopedIdentity(db, authority.revision);
    if (
      expected &&
      (identity.storeId !== expected.storeId ||
        identity.authorityEpoch !== expected.authorityEpoch ||
        identity.authorityRevision !== expected.authorityRevision)
    ) {
      throw new IndexerError(
        'coverage-authority-changed',
        'Native coverage authority changed during its owned observation.'
      );
    }
    const validatedProfiles = new Set<string>();
    return requests.map(({ request, selected, profile, profileHash }) => {
      authority.validateStoredBindings(db, selected);
      if (profileHash && !validatedProfiles.has(profileHash)) {
        validateScopedStorage(db, profileHash);
        validatedProfiles.add(profileHash);
      }
      const counts = selectedCounts(db, request.scope, selected, profileHash);
      return decoder(scopedCoverageSchema)({
        ...identity,
        counts,
        profile,
        profileHash,
        scope: request.scope,
        vectorCoverageComplete:
          profile !== null &&
          counts.indexedFiles === selected.length &&
          counts.chunks > 0 &&
          counts.vectors === counts.chunks &&
          counts.missingVectors === 0,
      });
    });
  })();
}
