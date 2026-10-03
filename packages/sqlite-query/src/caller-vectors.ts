import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { decodeIndexIdentityRow } from '@brainstrike/indexer/metadata';
import { Schema } from 'effect';

const decodeCount = makeThrowingDecoder(Schema.Struct({ count: Schema.Int }));
const decodeChunk = makeThrowingDecoder(
  Schema.Struct({
    contentHash: Schema.String,
    emb: Schema.NullOr(Schema.Uint8Array),
    embeddingHash: Schema.NullOr(Schema.String),
    hasVector: Schema.Literals([0, 1]),
    rootId: Schema.String,
    vectorRootId: Schema.NullOr(Schema.String),
  })
);
const CALLER_SCOPE = `WITH RECURSIVE callers(file_record_id,seq,name,depth) AS (
  SELECT file_record_id,seq,name,0 FROM file_symbols WHERE name=?
  UNION
  SELECT enclosing.file_record_id,enclosing.seq,enclosing.name,c.depth+1
  FROM callers c JOIN file_symbol_refs r ON r.name=c.name AND r.kind='call'
  JOIN file_symbols enclosing ON enclosing.file_record_id=r.file_record_id AND enclosing.seq=r.from_symbol_seq
  WHERE c.depth<10
), reachable AS (SELECT DISTINCT file_record_id FROM callers)`;

/** Called only inside the query owner's private read snapshot. */
export function requireCallerVectors(database: DatabaseSync, symbol: string): void {
  const identity = decodeIndexIdentityRow(
    database
      .prepare(
        'SELECT schema_version AS schemaVersion,store_id AS storeId,index_mode AS indexMode,profile_json AS profileJson,profile_hash AS profileHash FROM index_metadata WHERE singleton=1'
      )
      .get()
  );
  if (identity.embedding.indexMode !== 'vector-configured') {
    throw new TypeError(
      'Caller-vector lens requires an explicitly configured complete vector profile.'
    );
  }
  if (
    decodeCount(
      database.prepare('SELECT count(*) AS count FROM file_symbols WHERE name=?').get(symbol)
    ).count === 0
  ) {
    throw new TypeError('Caller-vector lens requires an existing seed symbol.');
  }
  const rows = database.prepare(`${CALLER_SCOPE}
    SELECT ch.content_hash AS contentHash,ch.embedding_hash AS embeddingHash,ch.has_vector AS hasVector,ch.root_id AS rootId,v.root_id AS vectorRootId,v.emb
    FROM file_chunks ch JOIN reachable rf ON rf.file_record_id=ch.file_record_id
    LEFT JOIN vec_chunks v ON v.id=ch.pk`);
  let chunks = 0;
  for (const raw of rows.iterate(symbol)) {
    const row = decodeChunk(raw);
    const hash = createHash('sha256')
      .update(JSON.stringify([identity.embedding.profileHash, row.contentHash]))
      .digest('hex');
    if (
      row.embeddingHash !== hash ||
      row.hasVector !== 1 ||
      row.vectorRootId !== row.rootId ||
      row.emb === null
    ) {
      throw new TypeError(
        'Caller-vector lens requires complete vectors with the stored profile for every graph-scoped chunk.'
      );
    }
    requireFiniteVector(row.emb, identity.embedding.profile.dimensions);
    chunks += 1;
  }
  if (
    chunks === 0 ||
    decodeCount(
      database
        .prepare(
          'SELECT count(*) AS count FROM file_chunks ch JOIN file_symbols s ON s.file_record_id=ch.file_record_id JOIN vec_chunks v ON v.id=ch.pk AND v.root_id=ch.root_id WHERE s.name=? AND ch.start_line<=s.start_line AND ch.end_line>=s.start_line AND ch.has_vector=1'
        )
        .get(symbol)
    ).count === 0
  ) {
    throw new TypeError(
      'Caller-vector lens requires a vector-bearing source chunk containing the seed symbol.'
    );
  }
}

function requireFiniteVector(bytes: Uint8Array, dimensions: number): void {
  if (bytes.byteLength !== dimensions * 4) {
    throw new TypeError(
      'Caller-vector lens requires complete vectors of the configured dimension.'
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let norm = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const value = view.getFloat32(index * 4, true);
    if (!Number.isFinite(value)) {
      throw new TypeError('Caller-vector lens requires finite vector components.');
    }
    norm += value * value;
  }
  if (norm === 0) {
    throw new TypeError('Caller-vector lens requires nonzero vectors for cosine distance.');
  }
}
