/**
 * Parser adapter contract for the chunking worker.
 *
 * The chunking worker needs JS/TS AST information to identify function-level
 * boundaries for AST-aware chunking. Historically that was done by importing
 * @babel/parser directly inside portable-chunking.ts. The adapter pattern
 * lets us swap parser implementations (Babel today, oxc-parser via Electron
 * IPC in future phases) without touching the consumer.
 *
 * Contract requirements:
 *  - Adapters MUST return an AstNode-shaped tree whose nodes carry `type`,
 *    `start`, and `end` (matching the existing portable-chunking AstNode shape).
 *  - Adapters MUST be safe to call repeatedly; lifetime management is the
 *    adapter's responsibility (e.g., loading babel lazily on first parse).
 *  - Adapters SHOULD NOT throw on recoverable syntax errors when
 *    `errorRecovery: true` is requested; they should return a best-effort tree.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §4
 */

/**
 * Generic AST node shape consumed by `iterateAstChildren` in portable-chunking.
 * Intentionally permissive — we only rely on `type`, `start`, and `end`, and
 * walk children generically via `Object.values`/array iteration.
 */
export type AstNode = {
  type?: string;
  start?: number;
  end?: number;
} & Record<string, unknown>;

/**
 * Options passed to every parser adapter.
 * Kept deliberately narrow — anything Babel-specific (plugin lists, source
 * type negotiation, etc.) is the adapter's internal responsibility.
 */
export interface ParseOptions {
  /**
   * Whether to enable best-effort error recovery for malformed source.
   * When false, adapters MAY throw on syntax errors.
   */
  readonly errorRecovery: boolean;
  /** Whether the source may contain JSX syntax. */
  readonly jsx: boolean;
  /** Source language. Adapters route to the right parser dialect. */
  readonly language: 'javascript' | 'typescript';
}

/**
 * The single abstraction every parser implementation satisfies.
 *
 * Implementations:
 *  - `babel-adapter` — pure-JS @babel/parser, runs everywhere
 *  - `oxc-ipc-adapter` — Electron IPC client for the native oxc parser host
 *    (added in Phase 4)
 */
export interface ParserAdapter {
  /** Adapter identity, used for telemetry and routing decisions. */
  readonly id: 'babel' | 'oxc-native';

  /**
   * Parse the given source into an `AstNode` tree.
   *
   * @param content - JS/TS source text
   * @param options - language/JSX/error-recovery flags
   * @returns root AstNode of the parsed tree
   * @throws when `options.errorRecovery === false` and source is malformed
   */
  parse(content: string, options: ParseOptions): Promise<AstNode>;
}
