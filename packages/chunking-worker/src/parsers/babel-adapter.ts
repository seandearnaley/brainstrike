/**
 * Babel parser adapter.
 *
 * Wraps `@babel/parser` to satisfy the `ParserAdapter` contract defined in
 * `./types.ts`. Phase 2 of the PRD extracts the Babel parsing logic that
 * historically lived inline in `portable-chunking.ts` so consumers can call
 * a single `selectAdapter()` facade and not care which engine is underneath.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §4
 */

import type { AstNode, ParseOptions, ParserAdapter } from './types';

/**
 * STUB — Phase 2 Cycle 2.1 RED state.
 *
 * The real implementation lands in Cycle 2.1 GREEN. This stub exists only so
 * the test file type-checks (the project's pre-commit hook runs `turbo run
 * type-check`, which would reject a missing-module RED). The stub throws so
 * the awaiting test fails at runtime — the genuine red bar we want.
 *
 * TODO(Phase 2 Cycle 2.1 GREEN): replace this body with a working call into
 * `@babel/parser`, mirroring the parser options used in
 * `portable-chunking.ts` (sourceType: 'module', appropriate plugins for the
 * requested language/JSX flags, errorRecovery: options.errorRecovery).
 */
async function parse(_content: string, _options: ParseOptions): Promise<AstNode> {
  throw new Error('babelAdapter.parse not implemented (Phase 2 Cycle 2.1 GREEN pending)');
}

export const babelAdapter: ParserAdapter = {
  id: 'babel',
  parse,
};
