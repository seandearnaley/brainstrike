/**
 * Parser adapter selection facade.
 *
 * Returns the right `ParserAdapter` for the file being parsed when the caller
 * passes no `CanonicalChunkingRuntime`. Node callers pass their own runtime
 * (`canonicalChunker` in canonical.ts, e.g. oxc-native via
 * `createNodeChunker`) and never reach this facade; without a runtime the
 * portable JS/TS adapter is Babel.
 *
 * Routing matrix:
 *   fileName ends with .py/.pyi AND
 *     getEnabledTreeSitterLanguages() includes 'python'  → tree-sitter('python')
 *   fileName ends with .py/.pyi otherwise                 → null
 *   any other fileName, or fileName is undefined          → babel
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
import { getEnabledTreeSitterLanguages } from './environment';
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
 * Synchronous by design: called on every parse, must not block. Node
 * callers pass their runtime instead; here JS/TS always parses with Babel.
 *
 * @param fileName - optional file name/path. When provided, used to route
 *                   tree-sitter-supported extensions (Phase 5+). When
 *                   omitted, behaves as pre-Phase-5 (JS/TS only).
 * @returns the ParserAdapter for this file, OR null when no parser can
 *          honestly handle it (e.g., `.py` file but python tree-sitter is
 *          disabled — babel can't parse Python so returning babel would
 *          be a contract violation). Callers MUST handle null by either
 *          falling back to a non-AST strategy (recursive splitter) or
 *          surfacing the unsupported-file condition.
 */
export function selectAdapter(fileName?: string): ParserAdapter | null {
  // Tree-sitter routing (PRD §9.1): only when both extension matches AND
  // the languages global opts in. Default-off; canonical chunkers pass a
  // runtime that always parses Python instead.
  //
  // Strict mode (Phase 9, per feedback_no_silent_fallbacks): a .py file
  // with python disabled returns NULL — not babel. Returning babel for
  // Python would be a lie (babel cannot parse Python source); the call
  // would fail with a confusing syntax error at parse time. Null forces
  // the caller to choose: recursive fallback (loud-degrade) or refusal.
  if (fileName && endsWithAny(fileName, PYTHON_EXTENSIONS)) {
    const enabled = getEnabledTreeSitterLanguages();
    if (enabled.includes('python')) {
      return treeSitterAdapter('python');
    }
    return null;
  }

  return babelAdapter;
}
