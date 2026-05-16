/**
 * Shared request/response types for the parser host utility process.
 *
 * The parser host runs in an Electron `utilityProcess` (Node, no DOM, no UI)
 * and exposes a single capability: parse JS/TS source into an `AstNode` tree
 * that the chunking-worker can consume. Communication is structured-clone
 * `process.parentPort` messages — same pattern as `db-host-shared.ts` and
 * `chunking-host-shared.ts`.
 *
 * Phase 3 of the chunking-parser PRD introduces this host. Phase 4 wires it
 * into the main process via `ParserHostManager` (mirroring `DbHostManager`).
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §4
 */

/**
 * Generic AST node shape returned by the parser. Permissive on purpose —
 * the chunking consumer walks tree children generically and only relies on
 * `type`, `start`, and `end`. Matches the contract in
 * `packages/chunking-worker/src/parsers/types.ts`.
 */
export type ParserHostAstNode = {
  type?: string;
  start?: number;
  end?: number;
} & Record<string, unknown>;

/** Parse options accepted by the host. */
export interface ParserHostParseOptions {
  readonly errorRecovery: boolean;
  readonly jsx: boolean;
  readonly language: 'javascript' | 'typescript';
}

/** A single parse request from the chunking-worker side. */
export interface ParserHostParseRequest {
  readonly content: string;
  readonly options: ParserHostParseOptions;
  readonly requestId: string;
}

/** Successful parse response. */
export interface ParserHostParseSuccess {
  readonly ok: true;
  readonly requestId: string;
  readonly root: ParserHostAstNode;
}

/** Failed parse response. The `error` is a serialized message safe to log. */
export interface ParserHostParseFailure {
  readonly error: string;
  readonly ok: false;
  readonly requestId: string;
}

export type ParserHostParseResponse = ParserHostParseFailure | ParserHostParseSuccess;
