/**
 * Persistence for the symbol graph (migration 075, BST-919).
 *
 * Symbols and refs share the chunk lifecycle: extracted at chunking time,
 * hard-deleted on managed-cache REPLACE, cascaded on file deletion. The refs'
 * `fromSymbolId` must point into the SAME insert batch — that intra-batch
 * invariant is what keeps enclosing-definition edges safe under re-index churn
 * (cross-file edges are name-joined at query time instead; see the design
 * ruling in `075-file-symbols.ts`).
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
  readonly embeddingSetId?: string;
  readonly endLine: number;
  readonly endOffset: number;
  readonly exported: boolean;
  readonly fileRecordId: string;
  readonly id: string;
  readonly kind: FileSymbolKind;
  readonly name: string;
  readonly startLine: number;
  readonly startOffset: number;
}

export interface FileSymbolRefInsert {
  readonly embeddingSetId?: string;
  readonly fileRecordId: string;
  /** Enclosing definition; MUST be an id from the same insert batch (or a
   * symbol already present for the same file). NULL = module-level code. */
  readonly fromSymbolId?: string;
  readonly id: string;
  readonly kind: FileSymbolRefKind;
  readonly line: number;
  /** For imports: the source module specifier. */
  readonly module?: string;
  readonly name: string;
}

interface SymbolDatabase {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: SymbolTransaction) => Promise<T>): Promise<T>;
}

interface SymbolTransaction {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const SYMBOL_COLUMNS = 10;
const REF_COLUMNS = 8;

function placeholders(rowCount: number, columnCount: number): string {
  const rows: string[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const cells: string[] = [];
    for (let column = 0; column < columnCount; column += 1) {
      cells.push(`$${row * columnCount + column + 1}`);
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
   * Inserts a file's symbols and refs atomically. Symbols land first so ref
   * FKs onto same-batch enclosing definitions resolve; any FK violation (a
   * ref pointing outside the batch) rolls back BOTH inserts — an orphan edge
   * must never land.
   */
  async insertMany(
    symbols: readonly FileSymbolInsert[],
    refs: readonly FileSymbolRefInsert[]
  ): Promise<void> {
    if (symbols.length === 0 && refs.length === 0) {
      return;
    }

    await this.db.transaction(async (tx) => {
      if (symbols.length > 0) {
        const values = symbols.flatMap((row) => [
          row.id,
          row.fileRecordId,
          row.embeddingSetId ?? null,
          row.name,
          row.kind,
          row.exported,
          row.startLine,
          row.endLine,
          row.startOffset,
          row.endOffset,
        ]);
        await tx.query(
          `INSERT INTO file_symbols
             (id, file_record_id, embedding_set_id, name, kind, exported,
              start_line, end_line, start_offset, end_offset)
           VALUES ${placeholders(symbols.length, SYMBOL_COLUMNS)}`,
          values
        );
      }

      if (refs.length > 0) {
        const values = refs.flatMap((row) => [
          row.id,
          row.fileRecordId,
          row.embeddingSetId ?? null,
          row.fromSymbolId ?? null,
          row.name,
          row.kind,
          row.module ?? null,
          row.line,
        ]);
        await tx.query(
          `INSERT INTO file_symbol_refs
             (id, file_record_id, embedding_set_id, from_symbol_id, name, kind, module, line)
           VALUES ${placeholders(refs.length, REF_COLUMNS)}`,
          values
        );
      }
    });
  }

  /** Removes all symbols and refs for the given files. Refs cascade from
   * their enclosing symbol, but module-level refs have no enclosing symbol,
   * so both tables are deleted explicitly. */
  async deleteForFileRecords(fileRecordIds: readonly string[]): Promise<void> {
    if (fileRecordIds.length === 0) {
      return;
    }
    // Text-form comparison for the same legacy-id reason as the chunk delete
    // in applyManagedCacheReplacements.
    await this.db.query(
      'DELETE FROM file_symbol_refs WHERE file_record_id::text = ANY($1::text[])',
      [[...fileRecordIds]]
    );
    await this.db.query('DELETE FROM file_symbols WHERE file_record_id::text = ANY($1::text[])', [
      [...fileRecordIds],
    ]);
  }
}
