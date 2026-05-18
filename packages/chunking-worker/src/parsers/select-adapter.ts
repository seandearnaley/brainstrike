/**
 * Parser adapter selection facade.
 *
 * Returns the right `ParserAdapter` for the current execution context AND
 * the file being parsed. `portable-chunking.ts` calls this in the chunking
 * hot path — it never imports a specific adapter directly. That isolation
 * is what lets the routing matrix grow without touching the consumer.
 *
 * Routing matrix:
 *   fileName ends with .py/.pyi AND
 *     getEnabledTreeSitterLanguages() includes 'python'           → tree-sitter('python')
 *   fileName ends with .ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs OR
 *     fileName is undefined:
 *       environment == 'browser'                                    → babel
 *       environment == 'electron-chunking-host' AND flag == 'babel' → babel  (kill switch)
 *       environment == 'electron-chunking-host' AND flag == 'oxc'   → oxc
 *       environment == 'electron-chunking-host' AND flag == 'auto'  → oxc
 *
 * Phase 5 (tree-sitter PRD #998) added the filename-aware routing. Calls
 * without a filename preserve the pre-Phase-5 behavior (always JS/TS) so
 * any unmigrated call site keeps working.
 *
 * **No per-file Babel fallback** (decision: 2026-05-16). The earlier
 * `withFallback` wrapper silently routed failing oxc parses to Babel and
 * counted them via telemetry. Project owner direction: that hides bugs
 * exactly when they matter most. Now: if a parser throws, the call site's
 * existing strategy fallback (non-AST recursive chunking) takes over,
 * logged at warn level so it's visible.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §4, §9
 * See: docs/prd-chunking-tree-sitter-2026-05.md §9.1
 */

import { babelAdapter } from './babel-adapter';
import { getEnabledTreeSitterLanguages, getEnvironment, getParserFlag } from './environment';
import { oxcIpcAdapter } from './oxc-ipc-adapter';
import { treeSitterAdapter } from './tree-sitter-adapter';
import type { ParserAdapter } from './types';

/** Extensions tree-sitter handles per language. Phase 1 = Python. */
const PYTHON_EXTENSIONS = ['.py', '.pyi'];

function endsWithAny(fileName: string, extensions: readonly string[]): boolean {
  const lower = fileName.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

/**
 * Pick the parser adapter for the current call site.
 *
 * Synchronous by design: called on every parse, must not block. Reads
 * environment + flag from globalThis (set by the chunking-host bootstrap
 * in production; set directly by tests).
 *
 * @param fileName - optional file name/path. When provided, used to route
 *                   tree-sitter-supported extensions (Phase 5+). When
 *                   omitted, behaves as pre-Phase-5 (JS/TS only).
 */
export function selectAdapter(fileName?: string): ParserAdapter {
  // Tree-sitter routing (PRD §9.1): only when both extension matches AND
  // operator has opted in via the languages flag. Default-off during
  // Phases 2-7; Phase 8 flips the default.
  if (fileName && endsWithAny(fileName, PYTHON_EXTENSIONS)) {
    const enabled = getEnabledTreeSitterLanguages();
    if (enabled.includes('python')) {
      return treeSitterAdapter('python');
    }
    // Python file but tree-sitter Python disabled — fall through to the
    // JS/TS path. The caller's `supportsAst` gate (in chunkCode) is what
    // actually decides whether splitCodeByFunctions runs at all; here we
    // just preserve the contract that selectAdapter never returns null.
  }

  const env = getEnvironment();

  // Browser cannot reach the parser host's Electron IPC channel — always Babel.
  if (env === 'browser') {
    return babelAdapter;
  }

  // Electron chunking-host. Flag controls oxc vs Babel.
  const flag = getParserFlag();
  if (flag === 'babel') {
    return babelAdapter;
  }

  // 'oxc' or 'auto' → native oxc via IPC. No fallback wrapper: if oxc
  // fails, the failure surfaces loudly to the caller's catch block.
  return oxcIpcAdapter;
}
