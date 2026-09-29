/**
 * Writer child for the SIGKILL crash gate; the gate spawns it with
 * `node --import tsx` and kills it mid-transaction.
 *
 *   crash-injection-writer.ts <dataDir> <run> <seed>
 *
 * Opens the migrated on-disk data dir through the PRODUCTION factory and loops
 * committed transactions across every index access method the real schema uses:
 * btree, BM25 and GIN (pg_trgm + tsvector) on `file_records` / `file_chunks`,
 * HNSW + GIN on `brainstrike_thread_message_index`, and a precious ledger in
 * `mastra_messages`. After each COMMIT it prints an `acked` line naming the ids
 * that must survive. Deletes only touch rows from earlier runs, so a row the
 * parent was told to expect is never deleted by a later, unacknowledged commit.
 */
import { createEnginePglite } from '../../src/pglite-factory';
import {
  CHUNK_CAP,
  CHUNK_STRIDE,
  type CrashAck,
  createRandom,
  formatAck,
  INDEX_ROW_CAP,
  MAX_RUN,
  RESOURCE_ID,
  SEQ_SPAN,
  THREAD_ID,
} from './crash-injection-protocol';

const CHUNKS = 40;
const INDEX_ROWS = 8;
const EMBEDDED_FRACTION = 0.6;
const EMBEDDING_DIMENSIONS = 384;
const VACUUM_EVERY = 4;
const OLD_FILE_RECORD_RUNS = 4;
const VOCABULARY =
  'database recovery index vector search chunk thread message embedding postgres wasm electron backup restore corruption page block segment memtable merge posting term frequency document ranking'.split(
    ' '
  );
const EPOCH = "TIMESTAMPTZ '2026-01-01T00:00:00Z'";

function readArguments(): { dataDir: string; run: number; seed: number } {
  const [dataDir, runArgument, seedArgument] = process.argv.slice(2);
  const run = Number(runArgument);
  const seed = Number(seedArgument);
  if (!(dataDir && Number.isInteger(run) && run >= 1 && run <= MAX_RUN && Number.isInteger(seed))) {
    process.stderr.write(`usage: crash-injection-writer.ts <dataDir> <run 1..${MAX_RUN}> <seed>\n`);
    process.exit(2);
  }
  return { dataDir, run, seed };
}

const { dataDir, run, seed } = readArguments();
const random = createRandom(seed);
const word = (): string =>
  random() < 0.3
    ? `topic${Math.floor(random() * 400)}`
    : (VOCABULARY[Math.floor(random() * VOCABULARY.length)] as string);
const paragraph = (words: number): string => Array.from({ length: words }, word).join(' ');
const vector = (): string =>
  `[${Array.from({ length: EMBEDDING_DIMENSIONS }, () => (random() - 0.5).toFixed(4)).join(',')}]`;

async function main(): Promise<void> {
  const db = await createEnginePglite({ dataDir });
  await db.query('SELECT setseed($1)', [random() * 2 - 1]);
  // Stress thresholds, as in the durability gate: spill and merge BM25 segments early and
  // often, so a kill is far more likely to land inside a free-and-reallocate cycle.
  await db.exec(`
    SET pg_textsearch.bulk_load_threshold = 100;
    SET pg_textsearch.memtable_pages_threshold = 2;
    SET pg_textsearch.segments_per_level = 2;
  `);

  const fileRecordId = `crash-file-${run}`;
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt")
       VALUES ($1, $2, 'crash thread', now(), now()) ON CONFLICT (id) DO NOTHING`,
      [THREAD_ID, RESOURCE_ID]
    );
    await tx.query('INSERT INTO file_records (id, name, path, size) VALUES ($1, $2, $3, 0)', [
      fileRecordId,
      `crash-${run}.md`,
      `/crash/${run}.md`,
    ]);
    // ON DELETE CASCADE: an old run's whole chunk set leaves the BM25 index at once.
    await tx.query('DELETE FROM file_records WHERE id = $1', [
      `crash-file-${run - OLD_FILE_RECORD_RUNS}`,
    ]);
  });

  // Rows below these ordinals belong to earlier runs and are the only deletable ones.
  const runBase = run * SEQ_SPAN;
  for (let seq = 1; seq < SEQ_SPAN; seq++) {
    const generation = runBase + seq;
    const messageId = `crash-msg-${run}-${seq}`;
    const chunkIds = Array.from({ length: CHUNKS }, (_, i) => `chunk-${run}-${seq}-${i}`);
    const indexIds = Array.from({ length: INDEX_ROWS }, (_, i) => `crash-idx-${run}-${seq}-${i}`);

    await db.transaction(async (tx) => {
      // Precious ledger row: plain heap + btree, never deleted, must survive every kill.
      await tx.query(
        `INSERT INTO mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId")
         VALUES ($1, $2, $3::jsonb, 'user', 'v2', now(), $4)`,
        [messageId, THREAD_ID, JSON.stringify({ run, seq }), RESOURCE_ID]
      );
      await tx.query(`UPDATE mastra_threads SET "updatedAt" = now() WHERE id = $1`, [THREAD_ID]);
      await tx.query('UPDATE file_records SET size = size + 1, name = $2 WHERE id = $1', [
        fileRecordId,
        `crash-${run}-${seq}.md`,
      ]);

      // btree + BM25 + GIN(pg_trgm) + GIN(tsvector) on file_chunks.
      await tx.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash)
         SELECT t.id, $1, $2::int * ${CHUNK_STRIDE} + t.ord, t.content, md5(t.content)
         FROM unnest($3::text[], $4::text[]) WITH ORDINALITY AS t(id, content, ord)`,
        [fileRecordId, generation, chunkIds, chunkIds.map(() => paragraph(60))]
      );
      await tx.query(
        `UPDATE file_chunks SET content = content || ' ' || $1
         WHERE id IN (SELECT id FROM file_chunks ORDER BY random() LIMIT 15)`,
        [paragraph(12)]
      );
      await tx.query(
        `DELETE FROM file_chunks WHERE id IN (
           SELECT id FROM file_chunks WHERE chunk_index < $1 ORDER BY random() LIMIT 4)`,
        [runBase * CHUNK_STRIDE]
      );
      await tx.query(
        `DELETE FROM file_chunks WHERE id IN (
           SELECT id FROM file_chunks WHERE chunk_index < $1 ORDER BY chunk_index
           LIMIT GREATEST(0, (SELECT count(*) FROM file_chunks) - $2))`,
        [runBase * CHUNK_STRIDE, CHUNK_CAP]
      );

      // HNSW (partial, embedded rows only) + GIN(tsvector) + btree on the thread index.
      await tx.query(
        `INSERT INTO brainstrike_thread_message_index
           (message_id, thread_id, resource_id, role, content_text, content_hash,
            message_created_at, embedding, embedding_profile_id)
         SELECT t.id, $1, $2, 'user', t.content, md5(t.content),
                ${EPOCH} + make_interval(secs => $3::int),
                NULLIF(t.embedding, '')::vector,
                CASE WHEN t.embedding = '' THEN NULL ELSE 'default' END
         FROM unnest($4::text[], $5::text[], $6::text[]) AS t(id, content, embedding)`,
        [
          THREAD_ID,
          RESOURCE_ID,
          generation,
          indexIds,
          indexIds.map(() => paragraph(30)),
          indexIds.map(() => (random() < EMBEDDED_FRACTION ? vector() : '')),
        ]
      );
      await tx.query(
        `UPDATE brainstrike_thread_message_index
         SET embedding = $1::vector, embedding_profile_id = 'default',
             content_text = content_text || ' ' || $2, updated_at = now()
         WHERE message_id IN (
           SELECT message_id FROM brainstrike_thread_message_index ORDER BY random() LIMIT 4)`,
        [vector(), paragraph(8)]
      );
      const oldRows = `SELECT message_id FROM brainstrike_thread_message_index
                       WHERE message_created_at < ${EPOCH} + make_interval(secs => $1::int)`;
      await tx.query(
        `DELETE FROM brainstrike_thread_message_index
         WHERE message_id IN (${oldRows} ORDER BY random() LIMIT 2)`,
        [runBase]
      );
      await tx.query(
        `DELETE FROM brainstrike_thread_message_index WHERE message_id IN (${oldRows}
           ORDER BY message_created_at
           LIMIT GREATEST(0, (SELECT count(*) FROM brainstrike_thread_message_index) - $2))`,
        [runBase, INDEX_ROW_CAP]
      );
    });

    const ack: CrashAck = {
      chunkIds,
      fileRecordId,
      indexMessageIds: indexIds,
      messageId,
      run,
      seq,
    };
    process.stdout.write(formatAck(ack));
    if (seq % VACUUM_EVERY === 0) {
      // Reclaims dead index entries and returns freed BM25 pages to the free-space map.
      await db.exec('VACUUM file_chunks');
    }
  }
  throw new Error(`writer reached the ${SEQ_SPAN}-transaction ceiling without being killed`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
}
