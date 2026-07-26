/**
 * Persistence for the symbol graph (migration 075, BST-919).
 *
 * Symbols and refs share the chunk lifecycle: extracted at chunking time,
 * hard-deleted on managed-cache REPLACE, cascaded on file deletion. Rows are
 * keyed by composite (file_record_id, seq) — a MEASURED decision: v1's text
 * ids (`${fileRecordId}_sym_${n}`) plus per-column secondary indexes cost
 * ~98% of raw source bytes on this monorepo; see `075-file-symbols.ts`.
 *
 * A ref's `fromSymbolSeq` must point into the SAME insert batch — that
 * intra-batch invariant is what keeps enclosing-definition edges safe under
 * re-index churn (cross-file edges are name-joined at query time instead).
 */

export type FileSymbolKind =
  | 'class'
  | 'enum'
  | 'function'
  | 'interface'
  | 'method'
  | 'type'
  | 'variable';

export type FileSymbolRefKind = 'call' | 'extends' | 'implements' | 'import';

export interface FileSymbolInsert {
  readonly endLine: number;
  readonly endOffset: number;
  readonly exported: boolean;
  readonly fileRecordId: string;
  readonly kind: FileSymbolKind;
  readonly name: string;
  readonly seq: number;
  readonly startLine: number;
  readonly startOffset: number;
}

export interface FileSymbolRefInsert {
  readonly fileRecordId: string;
  /** Enclosing definition's seq; MUST come from the same insert batch.
   * Absent = module-level code. */
  readonly fromSymbolSeq?: number;
  readonly kind: FileSymbolRefKind;
  readonly line: number;
  /** For imports: the source module specifier. */
  readonly module?: string;
  readonly name: string;
  readonly seq: number;
}

/**
 * `query` is the ONLY requirement — deliberately. The background-indexing db
 * handle (the wrapper in workspace-collection-sync-provider) exposes no
 * `transaction`, so atomicity comes from issuing BOTH inserts as one statement
 * via a data-modifying CTE: one statement is one implicit transaction on any
 * conforming handle.
 */
interface SymbolDatabase {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const SYMBOL_COLUMNS = 9;
const REF_COLUMNS = 7;

/**
 * PostgreSQL's wire limit is 65,535 bind parameters. A file whose symbols and
 * refs exceed it is far outside anything the chunker admits (maxChunkableSize
 * caps file size long before this); refusing loudly beats splitting the insert
 * and losing single-statement atomicity.
 */
const MAX_INSERT_PARAMETERS = 65_000;

function placeholders(rowCount: number, columnCount: number, offset: number): string {
  const rows: string[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const cells: string[] = [];
    for (let column = 0; column < columnCount; column += 1) {
      cells.push(`$${offset + row * columnCount + column + 1}`);
    }
    rows.push(`(${cells.join(', ')})`);
  }
  return rows.join(', ');
}

export class FileSymbolRepository {
  private readonly db: SymbolDatabase;

  constructor(db: SymbolDatabase) {
    this.db = db;
  }

  /**
   * Inserts a file's symbols and refs atomically — as ONE statement. Symbols
   * land via a data-modifying CTE so ref FKs onto same-batch enclosing
   * definitions resolve within the statement; any FK violation (a ref pointing
   * outside the batch) aborts the whole statement, so an orphan edge can never
   * land. Single-statement atomicity is what lets this run on handles that
   * expose only `query` (the background-indexing wrapper).
   */
  async insertMany(
    symbols: readonly FileSymbolInsert[],
    refs: readonly FileSymbolRefInsert[]
  ): Promise<void> {
    if (symbols.length === 0 && refs.length === 0) {
      return;
    }
    // REPLACE semantics: chunk persistence survives a re-chunk because its
    // insert is an upsert; seq is deterministic here, so without this a
    // re-chunk of the same file (full-reindex recovery, retry after a crash
    // between insert and the chunk-count update) collides on the PK and the
    // STALE graph keeps answering traversals (#2032 review). Deleting first
    // makes persistence self-healing regardless of who re-chunks.
    await deleteFileSymbolsForFileRecords(this.db, [
      ...new Set([...symbols, ...refs].map((row) => row.fileRecordId)),
    ]);
    const parameterCount = symbols.length * SYMBOL_COLUMNS + refs.length * REF_COLUMNS;
    if (parameterCount > MAX_INSERT_PARAMETERS) {
      throw new Error(
        `Refusing symbol insert with ${parameterCount} bind parameters (limit ${MAX_INSERT_PARAMETERS}); ` +
          'this file is far outside chunkable bounds.'
      );
    }

    const symbolValues = symbols.flatMap((row) => [
      row.fileRecordId,
      row.seq,
      row.name,
      row.kind,
      row.exported,
      row.startLine,
      row.endLine,
      row.startOffset,
      row.endOffset,
    ]);
    const refValues = refs.flatMap((row) => [
      row.fileRecordId,
      row.seq,
      row.fromSymbolSeq ?? null,
      row.name,
      row.kind,
      row.module ?? null,
      row.line,
    ]);

    const symbolInsert = `INSERT INTO file_symbols
        (file_record_id, seq, name, kind, exported,
         start_line, end_line, start_offset, end_offset)`;
    const refInsert = `INSERT INTO file_symbol_refs
        (file_record_id, seq, from_symbol_seq, name, kind, module, line)`;

    if (refs.length === 0) {
      await this.db.query(
        `${symbolInsert} VALUES ${placeholders(symbols.length, SYMBOL_COLUMNS, 0)}`,
        symbolValues
      );
      return;
    }
    if (symbols.length === 0) {
      await this.db.query(
        `${refInsert} VALUES ${placeholders(refs.length, REF_COLUMNS, 0)}`,
        refValues
      );
      return;
    }

    await this.db.query(
      `WITH inserted_symbols AS (
         ${symbolInsert} VALUES ${placeholders(symbols.length, SYMBOL_COLUMNS, 0)}
       )
       ${refInsert} VALUES ${placeholders(refs.length, REF_COLUMNS, symbolValues.length)}`,
      [...symbolValues, ...refValues]
    );
  }

  /** Removes all symbols and refs for the given files. */
  async deleteForFileRecords(fileRecordIds: readonly string[]): Promise<void> {
    await deleteFileSymbolsForFileRecords(this.db, fileRecordIds);
  }
}

/**
 * THE single implementation of symbol-row deletion, shared by the repository,
 * the managed-cache REPLACE path, and full-reindex recovery — the lifecycle
 * rule (refs first because module-level refs have no enclosing symbol to
 * cascade from; text-form id comparison for the same legacy-id reason as the
 * chunk delete) lives here once so the copies cannot drift (#2032 review).
 */
export async function deleteFileSymbolsForFileRecords(
  db: SymbolDatabase,
  fileRecordIds: readonly string[]
): Promise<void> {
  if (fileRecordIds.length === 0) {
    return;
  }
  await db.query('DELETE FROM file_symbol_refs WHERE file_record_id::text = ANY($1::text[])', [
    [...fileRecordIds],
  ]);
  await db.query('DELETE FROM file_symbols WHERE file_record_id::text = ANY($1::text[])', [
    [...fileRecordIds],
  ]);
}
