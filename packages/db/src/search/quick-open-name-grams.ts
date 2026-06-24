import type { BrainstrikeDbTransactionClient } from '../architecture/brainstrike-db-client-contract.js';

const QUICK_OPEN_GRAM_MAX_LENGTH = 3;

export async function replaceQuickOpenNameGrams(
  db: BrainstrikeDbTransactionClient,
  fileRecordId: string,
  name: string
): Promise<void> {
  const normalizedName = normalizeQuickOpenText(name);
  const grams = createQuickOpenIndexedGrams(name);
  await db.exec('DELETE FROM file_record_name_grams WHERE file_record_id = ?', [fileRecordId]);
  await db.exec('DELETE FROM file_record_name_index WHERE file_record_id = ?', [fileRecordId]);
  await db.exec(
    'INSERT INTO file_record_name_index (file_record_id, normalized_name) VALUES (?, ?)',
    [fileRecordId, normalizedName]
  );
  if (grams.length === 0) {
    return;
  }
  const values = grams.map(() => '(?, ?)').join(', ');
  const params = grams.flatMap((gram) => [fileRecordId, gram]);
  await db.exec(
    `INSERT INTO file_record_name_grams (file_record_id, gram) VALUES ${values}`,
    params
  );
}

export async function backfillQuickOpenNameGrams(
  db: BrainstrikeDbTransactionClient
): Promise<void> {
  const result = await db.query<{ id: string; name: string }>('SELECT id, name FROM file_records');
  for (const row of result.rows) {
    await replaceQuickOpenNameGrams(db, row.id, row.name);
  }
}

export function createQuickOpenCandidateGrams(normalizedQuery: string): readonly string[] {
  if (normalizedQuery.length <= QUICK_OPEN_GRAM_MAX_LENGTH) {
    return [normalizedQuery];
  }
  const grams = new Set<string>();
  for (let index = 0; index <= normalizedQuery.length - QUICK_OPEN_GRAM_MAX_LENGTH; index++) {
    grams.add(normalizedQuery.slice(index, index + QUICK_OPEN_GRAM_MAX_LENGTH));
  }
  return [...grams].sort();
}

export function normalizeQuickOpenText(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function createQuickOpenIndexedGrams(name: string): readonly string[] {
  const normalized = normalizeQuickOpenText(name);
  const grams = new Set<string>();
  for (let width = 1; width <= Math.min(QUICK_OPEN_GRAM_MAX_LENGTH, normalized.length); width++) {
    for (let index = 0; index <= normalized.length - width; index++) {
      grams.add(normalized.slice(index, index + width));
    }
  }
  return [...grams].sort();
}
