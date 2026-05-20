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
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';

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

/**
 * IPC channel name for parse requests from chunking-host renderer to main.
 * Main process forwards to the parser-host utility process via
 * `ParserHostManager.parse()`.
 */
export const PARSER_HOST_PARSE_CHANNEL = DESKTOP_IPC_CHANNELS.files.parserHostParse;

/**
 * Conservative type guard for `ParserHostParseRequest`. Shared between the
 * IPC layer (`ipc-parser-host.ts`) and the utility-process entry
 * (`parser-host-entry.ts`) so we don't drift two copies of the same logic.
 */
export function isParserHostParseRequest(value: unknown): value is ParserHostParseRequest {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (typeof v['requestId'] !== 'string' || typeof v['content'] !== 'string') {
    return false;
  }
  const opts = v['options'];
  if (opts === null || typeof opts !== 'object') {
    return false;
  }
  const o = opts as Record<string, unknown>;
  return (
    (o['language'] === 'javascript' || o['language'] === 'typescript') &&
    typeof o['jsx'] === 'boolean' &&
    typeof o['errorRecovery'] === 'boolean'
  );
}

/**
 * Best-effort extraction of `requestId` from an unknown payload — preserves
 * the correlation ID even when the overall payload is malformed so the
 * client's pending-request map can clean up.
 */
export function extractParserHostRequestId(value: unknown): string {
  if (value !== null && typeof value === 'object' && 'requestId' in value) {
    const id = (value as { requestId?: unknown }).requestId;
    if (typeof id === 'string') {
      return id;
    }
  }
  return 'unknown';
}
