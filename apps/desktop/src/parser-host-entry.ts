/**
 * Parser host utility process entry point.
 *
 * Loaded by `ParserHostManager` via Electron `utilityProcess.fork()`. Exposes
 * `handleParseRequest()` as a pure function for unit testing, and runs
 * `wireParentPort()` at module load to register the IPC listener when
 * launched as a utility-process entry.
 *
 * The actual parsing uses `oxc-parser` (Rust NAPI) — much faster than the
 * Babel parser used historically by the chunking-worker. The chunking-worker
 * routes here in Electron via the IPC adapter (Phase 5); browser builds
 * stay on Babel because oxc has no WASM build (PRD Appendix A).
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §4
 */

import { parseSync } from 'oxc-parser';
import type {
  ParserHostAstNode,
  ParserHostParseOptions,
  ParserHostParseRequest,
  ParserHostParseResponse,
} from './parser-host-shared';

/**
 * Minimal parentPort shape we depend on. Mirrors the surface in
 * `db-host-entry.ts` rather than importing Electron types directly so this
 * module remains testable in the same vitest environment that runs
 * pure-Node unit tests.
 */
interface ParentPortLike {
  readonly on: (event: 'message', listener: (message: unknown) => void) => unknown;
  readonly postMessage: (message: ParserHostParseResponse) => void;
}

/**
 * Map our `ParseOptions` to a synthetic filename whose extension oxc-parser
 * uses to choose the parser dialect. This is the documented oxc API: it
 * looks at the filename extension to pick js/jsx/ts/tsx parsing rules.
 *
 * The synthetic name never touches disk — it's purely a dialect signal.
 */
/**
 * Extract a human-readable error message from oxc's `result.errors`.
 *
 * oxc's diagnostic shape is version-dependent: in some configurations it
 * returns rich `OxcDiagnostic` objects (with `.message`), in others a
 * plain `string[]`. We handle both rather than falling through to a
 * generic "errors reported" message that loses signal.
 */
function extractFirstErrorMessage(errors: readonly unknown[]): string {
  const first = errors[0];
  if (typeof first === 'string' && first.length > 0) {
    return first;
  }
  if (first && typeof first === 'object' && 'message' in first) {
    const message = (first as { message: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  return 'oxc-parser reported errors and errorRecovery is disabled';
}

function deriveFilename(options: ParserHostParseOptions): string {
  if (options.language === 'typescript') {
    return options.jsx ? 'source.tsx' : 'source.ts';
  }
  return options.jsx ? 'source.jsx' : 'source.js';
}

/**
 * Parse a single source file using oxc-parser.
 *
 * Error model (oxc differs from Babel here):
 *   - oxc.parseSync ALWAYS returns a `program` even when source is malformed
 *     (best-effort recovery is the default)
 *   - Errors are surfaced via `result.errors` (an array)
 *
 * Our adapter contract treats the flag this way:
 *   - errorRecovery: true  → always return ok with the (possibly partial) tree
 *   - errorRecovery: false → return ok only if errors.length === 0; otherwise
 *     return a failure response with the first error message
 */
// The signature is async/Promise even though the body is fully synchronous
// today (oxc-parser.parseSync). Intentional, for two reasons: (1) the IPC
// boundary in Phase 4 always returns a Promise, so callers already await,
// and changing this to sync would force one more API rev with no payoff;
// (2) the Phase 7+ benchmark and any future remote-parser path are async.
// The per-call microtask cost is negligible against the parse work itself.
export async function handleParseRequest(
  request: ParserHostParseRequest
): Promise<ParserHostParseResponse> {
  try {
    const filename = deriveFilename(request.options);
    const result = parseSync(filename, request.content);

    if (!request.options.errorRecovery && result.errors.length > 0) {
      return {
        error: extractFirstErrorMessage(result.errors),
        ok: false,
        requestId: request.requestId,
      };
    }

    // The double cast through `unknown` is the documented TS pattern for
    // crossing between an incompatible-but-runtime-safe type pair. Our
    // ParserHostAstNode is intentionally permissive (type/start/end optional,
    // arbitrary other props) while oxc's Program is a closed shape — at
    // runtime they overlap perfectly, but the static types don't.
    return {
      ok: true,
      requestId: request.requestId,
      root: result.program as unknown as ParserHostAstNode,
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      ok: false,
      requestId: request.requestId,
    };
  }
}

/**
 * Validate that an unknown payload looks like a `ParserHostParseRequest`.
 * Conservative on purpose — anything not strictly matching the shape is
 * rejected with a failure response rather than crashing the host.
 */
function isParseRequest(value: unknown): value is ParserHostParseRequest {
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
 * Unwrap the Electron MessageEvent envelope. Some `parentPort.on('message')`
 * deliveries arrive as `{ data: payload }` (the MessageEvent shape) rather
 * than as the raw payload. Mirrors `unwrapParentPortMessage` in
 * `db-host-entry.ts`.
 */
function unwrapMessage(message: unknown): unknown {
  if (message !== null && typeof message === 'object' && 'data' in message) {
    return (message as { readonly data?: unknown }).data;
  }
  return message;
}

/**
 * Best-effort extraction of `requestId` from an unknown payload — used to
 * preserve correlation IDs even when the payload is otherwise malformed.
 */
function extractRequestId(value: unknown): string {
  if (value !== null && typeof value === 'object' && 'requestId' in value) {
    const id = (value as { requestId?: unknown }).requestId;
    if (typeof id === 'string') {
      return id;
    }
  }
  return 'unknown';
}

/**
 * Wire the parser host to Electron's `process.parentPort`. Idempotent at
 * module load: if `process.parentPort` is undefined (test/Node-without-
 * Electron), this returns without side effects, so tests can import
 * `handleParseRequest` directly without setting up a parentPort mock.
 */
export function wireParentPort(): void {
  const port = (process as NodeJS.Process & { parentPort?: ParentPortLike | null }).parentPort;
  if (!port) {
    return;
  }
  port.on('message', (rawMessage: unknown) => {
    const payload = unwrapMessage(rawMessage);
    if (!isParseRequest(payload)) {
      port.postMessage({
        error: 'Malformed parser host request envelope.',
        ok: false,
        requestId: extractRequestId(payload),
      });
      return;
    }
    void handleParseRequest(payload).then((response) => {
      port.postMessage(response);
    });
  });
}

// Auto-run at module load. Safe in tests: when process.parentPort is
// undefined (the default in vitest), wireParentPort returns without side
// effects. When the module is loaded inside an Electron utilityProcess,
// parentPort is defined and the wiring activates.
wireParentPort();
