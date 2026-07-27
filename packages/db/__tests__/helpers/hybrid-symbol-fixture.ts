import type { PGlite } from '@electric-sql/pglite';

/**
 * Shared fixture for the hybrid one-statement tests (BST-935) and the
 * callers-hybrid lens golden test (BST-921) — one seeding, two proofs.
 *
 * Call chain: main() -> run() -> startEmbeddingWorker(). `src/other.ts` is the
 * control: its chunk is BAIT for both arms (identical content and embedding to
 * the seed chunk) but it is unreachable in the graph, so its appearance in a
 * result means the traversal is not scoping the arms at all. `chunk-run-alt`
 * is a REACHABLE chunk embedded in a DIFFERENT set with different dimensions —
 * without embedding-set scoping the vector arm aborts on it.
 */

export const HYBRID_FIXTURE_SYMBOL = 'startEmbeddingWorker';
export const HYBRID_FIXTURE_TERMS = 'embedding worker lease';

/** english text-search config does NOT split camelCase, so the seed chunk
 * carries the query terms in prose (as a real doc comment would) — twice, so
 * it wins the BM25 arm outright rather than by a length tiebreak. */
const SEED_CONTENT =
  '/** embedding worker lease: acquires the embedding worker lease */ export function startEmbeddingWorker() {}';

export async function seedHybridSymbolFixture(db: PGlite): Promise<void> {
  await db.query(
    `INSERT INTO roots (id, kind, display_name, path) VALUES ('root-fixture', 'path', 'fixture', '/workspace/root')`
  );

  const files: [string, string][] = [
    ['file-worker', 'src/worker.ts'],
    ['file-run', 'src/run.ts'],
    ['file-main', 'src/main.ts'],
    ['file-other', 'src/other.ts'],
  ];
  for (const [id, path] of files) {
    await db.query(
      `INSERT INTO file_records (id, name, path, size, root_id)
       VALUES ($1, $2, $3, 10, 'root-fixture')`,
      [id, path.split('/').at(-1) ?? path, path]
    );
  }

  await db.query(
    `INSERT INTO file_symbols (file_record_id, seq, name, kind, exported, start_line, end_line, start_offset, end_offset)
     VALUES
       ('file-worker', 0, 'startEmbeddingWorker', 'function', true, 1, 20, 0, 400),
       ('file-run',    0, 'run',                  'function', true, 1, 20, 0, 400),
       ('file-main',   0, 'main',                 'function', true, 1, 20, 0, 400),
       ('file-other',  0, 'misc',                 'function', true, 1, 20, 0, 400)`
  );
  await db.query(
    `INSERT INTO file_symbol_refs (file_record_id, seq, name, kind, line, from_symbol_seq)
     VALUES
       ('file-run',  0, 'startEmbeddingWorker', 'call', 12, 0),
       ('file-main', 0, 'run',                  'call', 12, 0)`
  );

  const chunks: [string, string, string, string, string][] = [
    ['chunk-worker', 'file-worker', SEED_CONTENT, '[1,0,0]', 'set-a'],
    [
      'chunk-run',
      'file-run',
      'the run loop starts the embedding worker and holds its lease',
      '[0.9,0.1,0]',
      'set-a',
    ],
    [
      'chunk-main',
      'file-main',
      'main entrypoint wires configuration and telemetry',
      '[0,1,0]',
      'set-a',
    ],
    // Bait: identical content AND embedding to the seed chunk.
    ['chunk-other', 'file-other', SEED_CONTENT, '[1,0,0]', 'set-a'],
    // Mixed-dimension chunk in a reachable file (see module doc).
    ['chunk-run-alt', 'file-run', 'unrelated notes about scheduling', '[1,0,0,0,0]', 'set-b'],
  ];
  // start/end lines make each of these the chunk CONTAINING its file's symbol
  // definition (symbols are seeded at start_line 1) — the anchor the canonical
  // seed_embedding CTE selects by line containment.
  for (const [index, [id, fileRecordId, content, embedding, embeddingSetId]] of chunks.entries()) {
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, embedding, embedding_set_id, start_line, end_line)
       VALUES ($1, $2, $3, $4, $5::vector, $6, 1, 30)`,
      [id, fileRecordId, index, content, embedding, embeddingSetId]
    );
  }
}
