import type { BrainstrikeDbTransactionClient } from '../architecture/brainstrike-db-client-contract.js';

const GREP_CONTENT_GRAM_MAX_LENGTH = 3;
const GREP_CONTENT_GRAM_BATCH_SIZE = 250;

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
    await db.exec(
      `INSERT INTO file_chunk_content_grams (file_chunk_id, case_sensitive, gram)
       VALUES ${values}`,
      params
    );
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
