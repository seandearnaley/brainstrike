import { createLogger } from '@brainstrike/utils';
import type { BrainstrikeDbTransactionClient } from '../architecture/brainstrike-db-client-contract.js';

const GREP_CONTENT_GRAM_MAX_LENGTH = 3;
const GREP_CONTENT_GRAM_BATCH_SIZE = 250;

const logger = createLogger('DB:GrepContentGrams');

export async function replaceGrepContentIndex(
  db: BrainstrikeDbTransactionClient,
  fileChunkId: string,
  content: string
): Promise<void> {
  await db.exec('DELETE FROM file_chunk_content_grams WHERE file_chunk_id = ?', [fileChunkId]);
  await db.exec('DELETE FROM file_chunk_content_index WHERE file_chunk_id = ?', [fileChunkId]);
  await db.exec(
    `INSERT INTO file_chunk_content_index (file_chunk_id, normalized_content)
     VALUES (?, ?)`,
    [fileChunkId, normalizeGrepContentText(content)]
  );

  const indexedGrams = [
    ...createGrepContentIndexedGrams(content, true).map((gram) => [1, gram] as const),
    ...createGrepContentIndexedGrams(content, false).map((gram) => [0, gram] as const),
  ];
  for (let index = 0; index < indexedGrams.length; index += GREP_CONTENT_GRAM_BATCH_SIZE) {
    const batch = indexedGrams.slice(index, index + GREP_CONTENT_GRAM_BATCH_SIZE);
    if (batch.length === 0) {
      continue;
    }
    const values = batch.map(() => '(?, ?, ?)').join(', ');
    const params = batch.flatMap(([caseSensitive, gram]) => [fileChunkId, caseSensitive, gram]);
    // ON CONFLICT DO NOTHING: the DELETE above is the primary correctness
    // mechanism (it clears rows made stale by a content change). This insert
    // asserts a set of facts ("these grams exist for this chunk") that are
    // idempotent by nature — re-asserting an already-true fact should never
    // be an error. It is also a defense-in-depth guard: a live desktop repro
    // (multi-root workspace import, real content) hit a UNIQUE violation here
    // where the preceding DELETE provably did not clear a prior COMPLETE
    // gram set for the same file_chunk_id (existing row count was an exact
    // multiple of the batch size), despite the same sequence passing under
    // every isolated real-engine reproduction attempted (dup ids, re-import,
    // same/separate transactions, real diverse content at matching scale,
    // genuine Promise.all concurrency). The mechanism was not pinned down
    // within a reasonable investigation budget; ON CONFLICT DO NOTHING makes
    // the write correct regardless of that mechanism, since a duplicate
    // (file_chunk_id, case_sensitive, gram) tuple is never meaningful data.
    await db.exec(
      `INSERT INTO file_chunk_content_grams (file_chunk_id, case_sensitive, gram)
       VALUES ${values}
       ON CONFLICT (file_chunk_id, case_sensitive, gram) DO NOTHING`,
      params
    );
  }

  if (indexedGrams.length > 0) {
    await verifyGrepContentGramCount(db, fileChunkId, indexedGrams.length);
  }
}

// Not a correctness gate (ON CONFLICT DO NOTHING already makes the write
// safe) — this preserves the diagnostic visibility a hard failure used to
// give: if the actual row count ever diverges from what this call attempted
// to insert, that is real signal (either stale rows the DELETE didn't clear,
// or duplicate content within the batch), logged loudly rather than silently
// dropped. Caveat: a matching count is not proof of gram-identity
// correctness — it only rules out net row-count drift, not the (much less
// likely) case of stale rows and failed inserts coincidentally netting the
// same total. The count query itself is wrapped so a query failure here
// (distinct from a mismatch) is also surfaced rather than thrown, keeping
// this helper's failure mode strictly additive to replaceGrepContentIndex.
async function verifyGrepContentGramCount(
  db: BrainstrikeDbTransactionClient,
  fileChunkId: string,
  expectedCount: number
): Promise<void> {
  try {
    const result = await db.query<{ n: number | string | null }>(
      'SELECT COUNT(*) AS n FROM file_chunk_content_grams WHERE file_chunk_id = ?',
      [fileChunkId]
    );
    const actualCount = Number(result.rows[0]?.n ?? 0);
    if (actualCount !== expectedCount) {
      logger.warn('grep content gram count mismatch after replace', {
        fileChunkId,
        expectedCount,
        actualCount,
      });
    }
  } catch (error) {
    logger.warn('grep content gram count verification failed', {
      fileChunkId,
      expectedCount,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function backfillGrepContentIndex(db: BrainstrikeDbTransactionClient): Promise<void> {
  const result = await db.query<{ content: string; id: string }>(
    'SELECT id, content FROM file_chunks ORDER BY id'
  );
  for (const row of result.rows) {
    await replaceGrepContentIndex(db, row.id, row.content);
  }
}

export function createGrepContentCandidateGrams(
  literal: string,
  caseSensitive: boolean
): readonly string[] {
  const searchable = caseSensitive ? literal : normalizeGrepContentText(literal);
  if (searchable.length === 0) {
    return [];
  }
  const width = Math.min(GREP_CONTENT_GRAM_MAX_LENGTH, searchable.length);
  const grams = new Set<string>();
  for (let index = 0; index <= searchable.length - width; index += 1) {
    grams.add(searchable.slice(index, index + width));
  }
  return [...grams].sort();
}

export function normalizeGrepContentText(value: string): string {
  return value.toLowerCase();
}

function createGrepContentIndexedGrams(content: string, caseSensitive: boolean): readonly string[] {
  const searchable = caseSensitive ? content : normalizeGrepContentText(content);
  const grams = new Set<string>();
  for (
    let width = 1;
    width <= Math.min(GREP_CONTENT_GRAM_MAX_LENGTH, searchable.length);
    width += 1
  ) {
    for (let index = 0; index <= searchable.length - width; index += 1) {
      grams.add(searchable.slice(index, index + width));
    }
  }
  return [...grams].sort();
}
