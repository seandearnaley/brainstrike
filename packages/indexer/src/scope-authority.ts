import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { poolingIdentity, promptIdentity, validateSnapshot } from './chunks.js';
import {
  decoder,
  fileBindingsSchema,
  IndexerError,
  type IndexerOptions,
  type IndexFileBinding,
  type IndexScope,
  type ScopedFileSnapshot,
  type VectorProfile,
  vectorProfileSchema,
} from './contracts.js';
import { sha256Hex } from './portable.js';

export function vectorProfileHash(input: unknown): string {
  const profile = decoder(vectorProfileSchema)(input);
  return sha256Hex(
    JSON.stringify([
      profile.provider,
      profile.modelId,
      profile.dimensions,
      profile.distance,
      'revision' in profile ? profile.revision : null,
      'dtype' in profile ? profile.dtype : null,
      'tokenCap' in profile ? profile.tokenCap : null,
      ...poolingIdentity('pooling' in profile ? profile.pooling : undefined),
      ...promptIdentity('prompts' in profile ? profile.prompts : undefined),
    ])
  );
}
export function supportedVectorProfile(profile: VectorProfile): void {
  decoder(vectorProfileSchema)(profile);
}
export function scopeKey(scope: IndexScope): string {
  return JSON.stringify(scope);
}
export function matchesScope(
  file: Pick<IndexFileBinding, 'rootId' | 'embeddingSetId'>,
  scope: IndexScope
): boolean {
  return scope.kind === 'workspace'
    ? file.rootId === scope.rootId
    : file.embeddingSetId === scope.embeddingSetId;
}
export class ScopeAuthority {
  readonly scopes: ReadonlySet<string>;
  readonly files = new Map<string, IndexFileBinding>();
  revision = 0;
  constructor(options: IndexerOptions) {
    this.scopes = new Set([
      ...options.rootIds.map((rootId) => scopeKey({ kind: 'workspace', rootId })),
      ...(options.scopes ?? []).map(scopeKey),
    ]);
    this.replace(options.fileBindings ?? []);
  }
  authorize(scopes: readonly IndexScope[]): void {
    for (const scope of scopes) {
      if (!this.scopes.has(scopeKey(scope))) {
        throw new IndexerError(
          'scope-not-authorized',
          'Scope is not authorized by the index owner.'
        );
      }
    }
  }
  replace(input: unknown): void {
    const files = decoder(fileBindingsSchema)(input);
    const next = new Map<string, IndexFileBinding>();
    const collections = new Map<string, string | null>();
    for (const file of files) {
      validateSnapshot({ ...file, chunkLines: 1, content: '' });
      if (file.rootId === null && file.embeddingSetId === null) {
        throw new TypeError('A canonical file requires a workspace or collection owner.');
      }
      this.authorize([
        ...(file.rootId === null ? [] : [{ kind: 'workspace' as const, rootId: file.rootId }]),
        ...(file.embeddingSetId === null
          ? []
          : [{ embeddingSetId: file.embeddingSetId, kind: 'collection' as const }]),
      ]);
      if (next.has(file.fileId)) {
        throw new TypeError('Canonical file bindings must be unique.');
      }
      if (file.embeddingSetId !== null) {
        const profileHash = file.profile ? vectorProfileHash(file.profile) : null;
        if (
          collections.has(file.embeddingSetId) &&
          collections.get(file.embeddingSetId) !== profileHash
        ) {
          throw new TypeError(
            'Files in a collection must share its exact canonical vector profile.'
          );
        }
        collections.set(file.embeddingSetId, profileHash);
      }
      next.set(file.fileId, file);
    }
    this.files.clear();
    for (const [id, file] of next) {
      this.files.set(id, file);
    }
    this.revision += 1;
  }
  selectedFiles(scopes: readonly IndexScope[], fileIds?: readonly string[]): IndexFileBinding[] {
    const roots = new Set(
      scopes.flatMap((scope) => (scope.kind === 'workspace' ? [scope.rootId] : []))
    );
    const collections = new Set(
      scopes.flatMap((scope) => (scope.kind === 'collection' ? [scope.embeddingSetId] : []))
    );
    const requestedIds = fileIds ? new Set(fileIds) : null;
    return [...this.files.values()].filter(
      (file) =>
        ((file.rootId !== null && roots.has(file.rootId)) ||
          (file.embeddingSetId !== null && collections.has(file.embeddingSetId))) &&
        (!requestedIds || requestedIds.has(file.fileId))
    );
  }
  validateStoredBindings(db: Database.Database, selected: readonly IndexFileBinding[]): void {
    if (selected.length === 0) {
      return;
    }
    const files = new Map(selected.map((file) => [file.fileId, file]));
    const rows = decoder(
      Schema.Array(
        Schema.Struct({
          embeddingSetId: Schema.NullOr(Schema.String),
          fileId: Schema.String,
          relativePath: Schema.NullOr(Schema.String),
          rootId: Schema.NullOr(Schema.String),
          sourcePath: Schema.NullOr(Schema.String),
        })
      )
    )(
      db
        .prepare(
          'SELECT id AS fileId,root_id AS rootId,path AS relativePath,embedding_set_id AS embeddingSetId,source_path AS sourcePath FROM file_records WHERE scoped=1 AND id IN (SELECT value FROM json_each(?))'
        )
        .all(JSON.stringify([...files.keys()]))
    );
    for (const row of rows) {
      const file = files.get(row.fileId);
      if (!file) {
        throw new IndexerError(
          'file-not-authorized',
          'Derived read returned an unauthorized file.'
        );
      }
      for (const key of ['rootId', 'relativePath', 'embeddingSetId', 'sourcePath'] as const) {
        if (row[key] !== file[key]) {
          throw new IndexerError(
            'file-ownership-changed',
            'Derived metadata differs from the current catalog binding; republish or remove it before searching.'
          );
        }
      }
    }
  }
  file(fileId: string, scope?: IndexScope): IndexFileBinding {
    const file = this.files.get(fileId);
    if (!file || (scope && !matchesScope(file, scope))) {
      throw new IndexerError(
        'file-not-authorized',
        'Canonical file membership is not authorized by the index owner.'
      );
    }
    return file;
  }
  snapshot(snapshot: ScopedFileSnapshot, profile: VectorProfile | null): void {
    const file = this.file(snapshot.fileId);
    for (const key of ['rootId', 'relativePath', 'embeddingSetId', 'sourcePath'] as const) {
      if (file[key] !== snapshot[key]) {
        throw new IndexerError(
          'file-not-authorized',
          'Snapshot metadata differs from its trusted canonical file binding.'
        );
      }
    }
    if (
      profile &&
      (!file.profile || vectorProfileHash(profile) !== vectorProfileHash(file.profile))
    ) {
      throw new IndexerError(
        'profile-not-authorized',
        'Vector profile differs from the current canonical selection.'
      );
    }
  }
}
