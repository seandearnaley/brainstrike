/**
 * Parser host utility process entry point.
 *
 * Loaded by `ParserHostManager` (Phase 4) via Electron `utilityProcess.fork()`.
 * Exposes `handleParseRequest()` as a pure function for unit testing, and
 * wires it to `process.parentPort` when run as a utility-process entry.
 *
 * The actual parsing uses `oxc-parser` (Rust NAPI) — much faster than the
 * Babel parser used historically by the chunking-worker. The chunking-worker
 * routes here in Electron via the IPC adapter (Phase 5); browser builds
 * stay on Babel because oxc has no WASM build (PRD Appendix A).
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §4
 */

import type { ParserHostParseRequest, ParserHostParseResponse } from './parser-host-shared';

/**
 * STUB — Phase 3 Cycle 3.1 RED state.
 *
 * Returns a failure response so the test's success-path assertion fails at
 * runtime (not at the import). Replaced wholesale in Cycle 3.1 GREEN with
 * a real call to oxc.parseSync().
 *
 * TODO(Phase 3 Cycle 3.1 GREEN): replace with oxc-parser call. Map
 * options.language → file extension (.ts/.js) for parseSync's filename arg
 * (oxc uses extension to choose the parser dialect), thread options.jsx and
 * options.errorRecovery through, and return { ok: true, root: result.program }.
 */
export async function handleParseRequest(
  request: ParserHostParseRequest
): Promise<ParserHostParseResponse> {
  return {
    error: 'handleParseRequest not implemented (Phase 3 Cycle 3.1 GREEN pending)',
    ok: false,
    requestId: request.requestId,
  };
}
