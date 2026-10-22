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
