import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import {
  decoder,
  IndexerError,
  type ScopedFilePage,
  scopedFilePageRequestSchema,
  scopedFilePageSchema,
  scopedManifestChunkSchema,
} from './contracts.js';
import { readIndexIdentity, readScopeEpoch } from './index-metadata.js';
import { type ScopeAuthority, vectorProfileHash } from './scope-authority.js';
import { validateStoredVectorBytes } from './scoped-vector-validation.js';

const fileSchema = Schema.Struct({ contentHash: Schema.String, snapshotHash: Schema.String });
const rowSchema = Schema.Struct({
  ...scopedManifestChunkSchema.fields,
  content: Schema.String,
  dimensions: Schema.NullOr(Schema.Int),
  emb: Schema.NullOr(Schema.Uint8Array),
  vectorContentHash: Schema.NullOr(Schema.String),
});

export function readScopedFilePage(
  db: Database.Database,
  authority: ScopeAuthority,
  input: unknown
): ScopedFilePage {
  const request = decoder(scopedFilePageRequestSchema)(input);
  authority.authorize([request.scope]);
  const binding = authority.file(request.fileId, request.scope);
  const profileHash = binding.profile ? vectorProfileHash(binding.profile) : null;
  if (request.profileHash !== undefined && request.profileHash !== profileHash) {
    throw new IndexerError('profile-not-authorized', 'Native Library page profile changed.');
  }
  return db.transaction(() => {
    authority.validateStoredBindings(db, [binding]);
    const raw = db
      .prepare(
        'SELECT content_hash AS contentHash,snapshot_hash AS snapshotHash FROM file_records WHERE id=? AND scoped=1'
      )
      .get(binding.fileId);
    if (!raw) {
      throw new IndexerError('file-not-indexed', 'Canonical file has no current native chunks.');
    }
    const file = decoder(fileSchema)(raw);
    if (
      file.contentHash !== request.contentHash ||
      (request.snapshotHash !== undefined && request.snapshotHash !== file.snapshotHash)
    ) {
      throw new IndexerError('source-changed', 'Native Library page source changed.');
    }
    const total = decoder(Schema.Int)(
      db
        .prepare('SELECT COUNT(*) FROM file_chunks WHERE file_record_id=?')
        .pluck()
        .get(binding.fileId)
    );
    const rows = decoder(Schema.Array(rowSchema))(
      db
        .prepare(
          'SELECT c.id AS chunkId,c.content,c.content_hash AS contentHash,c.start_line AS startLine,c.end_line AS endLine,c.chunk_index AS chunkIndex,c.chunk_size AS chunkSize,c.chunk_type AS chunkType,c.start_offset AS startOffset,c.end_offset AS endOffset,c.token_count AS tokenCount,v.dimensions,v.emb,v.content_hash AS vectorContentHash FROM file_chunks c LEFT JOIN scoped_vectors v ON v.chunk_pk=c.pk AND v.profile_hash=? WHERE c.file_record_id=? ORDER BY c.chunk_index,c.pk LIMIT ? OFFSET ?'
        )
        .all(profileHash, binding.fileId, request.limit, request.offset)
    );
    const chunks = rows.map(({ dimensions, emb, vectorContentHash, ...chunk }) => {
      if (emb === null && dimensions === null) {
        return { ...chunk, vector: null };
      }
      if (
        emb === null ||
        dimensions === null ||
        dimensions !== binding.profile?.dimensions ||
        vectorContentHash !== chunk.contentHash
      ) {
        throw new IndexerError('rebuild-required', 'Native Library vector metadata is incomplete.');
      }
      validateStoredVectorBytes({ dimensions, emb });
      const view = new DataView(emb.buffer, emb.byteOffset, emb.byteLength);
      return {
        ...chunk,
        vector: {
          dimensions,
          values: Array.from({ length: dimensions }, (_, index) =>
            view.getFloat32(index * 4, true)
          ),
        },
      };
    });
    const next = request.offset + chunks.length;
    return decoder(scopedFilePageSchema)({
      authorityEpoch: readScopeEpoch(db),
      authorityRevision: authority.revision,
      fileId: binding.fileId,
      storeId: readIndexIdentity(db).storeId,
      ...file,
      chunks,
      nextOffset: next < total ? next : null,
      profileHash,
      total,
    });
  })();
}
