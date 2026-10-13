/// <reference lib="webworker" />
// BST-1940 spike: today's web database path, for comparison. Production code only: the engine factory
// (pglite-factory.ts, full extension set), the first-run fast bootstrap pipeline and the production
// migrations, on an idb:// store with strict durability, in a dedicated worker.
import type { PGlite } from '@electric-sql/pglite';
import { runFirstRunBootstrapPipeline } from '../../db/src/browser-first-run-bootstrap-pipeline';
import { migrate } from '../../db/src/migrations/bootstrap';
import { createEnginePglite } from '../../db/src/pglite-factory';
import { escapeLikeLiteral, extractTrigramLiteral } from '../../db/src/search/grep-pattern';
import recorded from '../../test-utils/fixtures/recorded-grep-patterns.json';
import { createGrepLineMatcher } from '../../utils/dist/grep-line-matcher.js';
import { crc32 } from './crc32';
import { chunkFiles, runSteps, wordsOf } from './workload.mjs';

declare const self: DedicatedWorkerGlobalScope;

let db: PGlite | undefined;
const words = wordsOf(recorded.patterns);
const now = () => performance.now();

async function open(input: { dataDir: string; firstRun: boolean }) {
  const started = now();
  if (input.firstRun) {
    await runFirstRunBootstrapPipeline(input.dataDir, {
      createMemoryDb: () => createEnginePglite(),
      createStoreLoadDb: (dataDir, dump) =>
        createEnginePglite({ dataDir, loadDataDir: dump, relaxedDurability: false }),
    });
  }
  const bootstrapped = now();
  db = await createEnginePglite({ dataDir: input.dataDir, relaxedDurability: false });
  const opened = now();
  await migrate(db);
  // The spike's run-log tables: the same columns as desktop run_events/threads/run_sync (not production PG).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS spike_run_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, thread_id text NOT NULL,
      seq integer NOT NULL, type text NOT NULL, run_id text, payload text NOT NULL, crc bigint NOT NULL, raw_count integer,
      created_at double precision NOT NULL, hydrate smallint NOT NULL DEFAULT 1, UNIQUE (thread_id, seq));
    CREATE TABLE IF NOT EXISTS spike_threads (id text PRIMARY KEY, last_seq integer NOT NULL, created_at double precision NOT NULL,
      updated_at double precision NOT NULL);
    CREATE TABLE IF NOT EXISTS spike_run_sync (thread_id text PRIMARY KEY, seq integer NOT NULL, at double precision NOT NULL);
  `);
  const ready = now();
  return {
    timings: {
      bootstrapMs: bootstrapped - started,
      migrateCheckMs: ready - opened,
      openMs: opened - bootstrapped,
      totalMs: ready - started,
    },
    version: (await db.query<{ v: string }>('SELECT version() AS v')).rows[0]?.v,
  };
}

async function appendRun(input: { threadId: string; steps: number; seed: number }) {
  const handle = db as PGlite;
  const tail = Number(
    (
      await handle.query<{ s: number }>(
        'SELECT coalesce(max(seq),0) AS s FROM spike_run_events WHERE thread_id=$1',
        [input.threadId]
      )
    ).rows[0]?.s ?? 0
  );
  const batches = runSteps({
    runId: `run-${input.seed}`,
    seed: input.seed,
    startSeq: tail + 1,
    steps: input.steps,
    threadId: input.threadId,
    words,
  });
  const batchMs: number[] = [];
  const boundaryMs: number[] = [];
  for (const batch of batches) {
    const at = Date.now();
    const begun = now();
    await handle.transaction(async (tx) => {
      for (const row of batch) {
        const payload = `{"seq":${row.seq},${row.body.slice(1)}`;
        await tx.query(
          'INSERT INTO spike_run_events (thread_id, seq, type, run_id, payload, crc, raw_count, created_at, hydrate) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            input.threadId,
            row.seq,
            row.type,
            `run-${input.seed}`,
            payload,
            crc32(payload),
            null,
            at,
            1,
          ]
        );
        await tx.query(
          'INSERT INTO spike_threads (id,last_seq,created_at,updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET last_seq=excluded.last_seq, updated_at=excluded.updated_at',
          [input.threadId, row.seq, at, at]
        );
      }
    });
    const committed = now();
    await handle.query(
      'INSERT INTO spike_run_sync (thread_id, seq, at) VALUES ($1,$2,$3) ON CONFLICT(thread_id) DO UPDATE SET seq = excluded.seq, at = excluded.at',
      [input.threadId, (batch.at(-1) as { seq: number }).seq, Date.now()]
    );
    batchMs.push(committed - begun);
    boundaryMs.push(now() - committed);
  }
  return { batchMs, boundaryMs, rows: batches.flat().length };
}

/** Production file_records + file_chunks (generated tsvector, GIN tsvector, GIN trgm, BM25 index). */
async function indexChunks(input: {
  files: number;
  fileOffset: number;
  chunksPerFile: number;
  linesPerChunk: number;
  seed: number;
}) {
  const handle = db as PGlite;
  const files = chunkFiles({ ...input, rootId: 'web-root', words });
  const begun = now();
  await handle.transaction(async (tx) => {
    for (const { chunks, file } of files) {
      await tx.query(
        'INSERT INTO file_records (id,name,path,size,content_hash,root_id,chunks_count) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [
          file.id,
          file.name,
          file.path,
          chunks.reduce((total, chunk) => total + chunk.chunk_size, 0),
          file.content_hash,
          file.root_id,
          chunks.length,
        ]
      );
      for (const chunk of chunks) {
        await tx.query(
          'INSERT INTO file_chunks (id,file_record_id,chunk_index,content,content_hash,token_count,chunk_type,chunk_size,start_line,end_line,start_offset,end_offset) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
          [
            chunk.id,
            chunk.file_record_id,
            chunk.chunk_index,
            chunk.content,
            chunk.content_hash,
            chunk.token_count,
            chunk.chunk_type,
            chunk.chunk_size,
            chunk.start_line,
            chunk.end_line,
            chunk.start_offset,
            chunk.end_offset,
          ]
        );
      }
    }
  });
  return {
    chunks: files.reduce((total, file) => total + file.chunks.length, 0),
    ms: now() - begun,
  };
}

/** file-chunk-repository.ts fullTextSearch (BM25 order) and grep-search-service candidates (pg_trgm ILIKE). */
async function search(input: { queries: readonly string[] }) {
  const handle = db as PGlite;
  const bm25: number[] = [];
  const grep: number[] = [];
  let hits = 0;
  let scanLimited = 0;
  for (const query of input.queries) {
    const text = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).join(' ');
    let begun = now();
    if (text) {
      hits += (
        await handle.query(
          `SELECT id, (-(content <@> to_bm25query($1, 'idx_file_chunks_content_bm25')))::float8 AS fts_rank
           FROM file_chunks WHERE content_tsvector IS NOT NULL AND content_tsvector @@ websearch_to_tsquery($2::regconfig, $1)
           ORDER BY fts_rank DESC, id LIMIT 21`,
          [text, 'english']
        )
      ).rows.length;
      bm25.push(now() - begun);
    }
    begun = now();
    // grep-search-service.ts resolveLikePattern + runFindGrepCandidatesQuery, default candidate limit 500.
    const literal = extractTrigramLiteral(query);
    const like = literal === null ? null : escapeLikeLiteral(literal);
    const matcher = createGrepLineMatcher(query, true, false);
    const rows = (
      like === null
        ? await handle.query<{ id: string; content: string }>(
            'SELECT fc.id, fc.content FROM file_chunks fc JOIN file_records fr ON fr.id = fc.file_record_id WHERE fr.root_id = $1 ORDER BY fc.id LIMIT 500',
            ['web-root']
          )
        : await handle.query<{ id: string; content: string }>(
            "SELECT fc.id, fc.content FROM file_chunks fc JOIN file_records fr ON fr.id = fc.file_record_id WHERE fc.content ILIKE $1 ESCAPE '\\' AND fr.root_id = $2 ORDER BY fc.id LIMIT 500",
            [`%${like}%`, 'web-root']
          )
    ).rows;
    scanLimited += rows.length >= 500 ? 1 : 0;
    hits += rows.filter((row) =>
      row.content.split('\n').some((line) => matcher.matches(line))
    ).length;
    grep.push(now() - begun);
  }
  return { bm25, grep, hits, scanLimited };
}

async function counts() {
  const handle = db as PGlite;
  const one = async (sql: string) =>
    Number((await handle.query<{ n: number }>(sql)).rows[0]?.n ?? 0);
  return {
    chunks: await one('SELECT count(*)::int AS n FROM file_chunks'),
    dbBytes: await one('SELECT pg_database_size(current_database())::bigint AS n'),
    events: await one('SELECT count(*)::int AS n FROM spike_run_events'),
  };
}

self.onmessage = async (event: MessageEvent<{ id: number; command: string; input: never }>) => {
  const { command, id, input } = event.data;
  const reply = (value: unknown) => self.postMessage({ id, value });
  try {
    switch (command) {
      case 'open':
        return reply(await open(input));
      case 'appendRun':
        return reply(await appendRun(input));
      case 'indexChunks':
        return reply(await indexChunks(input));
      case 'search':
        return reply(await search(input));
      case 'counts':
        return reply(await counts());
      case 'close':
        await db?.close();
        db = undefined;
        return reply({ closed: true });
      default:
        throw new Error(`unknown command ${command}`);
    }
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      id,
    });
  }
};
