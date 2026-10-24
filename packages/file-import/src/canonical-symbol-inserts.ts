import type { PortableSymbol, PortableSymbolRef } from '@brainstrike/chunking-worker';

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
 * Convert extracted symbols/refs to database inserts (BST-919).
 *
 * `seq` IS the extraction-order index — the same number the extractor already
 * used for `enclosingSymbolIndex`, so the enclosing edge maps through without
 * translation. An out-of-range enclosing index is a contract violation from
 * the worker and throws rather than inserting an edge attributed to the wrong
 * definition.
 */
export function toFileSymbolInserts(
  fileRecordId: string,
  symbols: readonly PortableSymbol[],
  refs: readonly PortableSymbolRef[]
): { refs: FileSymbolRefInsert[]; symbols: FileSymbolInsert[] } {
  const symbolInserts: FileSymbolInsert[] = symbols.map((symbol, index) => ({
    endLine: symbol.endLine,
    endOffset: symbol.endOffset,
    exported: symbol.exported,
    fileRecordId,
    kind: symbol.kind,
    name: symbol.name,
    seq: index,
    startLine: symbol.startLine,
    startOffset: symbol.startOffset,
  }));

  const refInserts: FileSymbolRefInsert[] = refs.map((ref, index) => {
    if (ref.enclosingSymbolIndex !== undefined && !symbolInserts[ref.enclosingSymbolIndex]) {
      throw new Error(
        `Symbol ref ${index} references enclosing symbol index ${ref.enclosingSymbolIndex}, ` +
          `but only ${symbolInserts.length} symbols were extracted.`
      );
    }
    return {
      fileRecordId,
      kind: ref.kind,
      line: ref.line,
      name: ref.name,
      seq: index,
      ...(ref.enclosingSymbolIndex === undefined
        ? {}
        : { fromSymbolSeq: ref.enclosingSymbolIndex }),
      ...(ref.module === undefined ? {} : { module: ref.module }),
    };
  });

  return { refs: refInserts, symbols: symbolInserts };
}
