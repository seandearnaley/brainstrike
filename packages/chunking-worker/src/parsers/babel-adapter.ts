/**
 * Babel parser adapter.
 *
 * Wraps `@babel/parser` to satisfy the `ParserAdapter` contract defined in
 * `./types.ts`. Phase 2 of the PRD extracts the Babel parsing logic that
 * historically lived inline in `portable-chunking.ts` so consumers can call
 * a single `selectAdapter()` facade and not care which engine is underneath.
 *
 * The plugin list and parse options mirror the original call site at
 * portable-chunking.ts:752 so chunk boundaries remain byte-identical to the
 * pre-refactor behavior.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §4
 */

import type { ParserPlugin } from '@babel/parser';
import type { AstNode, ParseOptions, ParserAdapter } from './types';

type BabelParserModule = typeof import('@babel/parser');

/**
 * Lazy singleton of the Babel parser module. Mirrors the loader pattern that
 * already exists in portable-chunking.ts so the cost of loading Babel is paid
 * once per worker, not once per parse.
 */
let babelParserPromise: Promise<BabelParserModule> | null = null;

function loadBabelParser(): Promise<BabelParserModule> {
  if (!babelParserPromise) {
    babelParserPromise = import('@babel/parser').catch((error: unknown) => {
      babelParserPromise = null;
      throw error;
    });
  }
  return babelParserPromise;
}

/**
 * Build the Babel parser plugin list for a given `ParseOptions`.
 *
 * Preserves the historical defaults from portable-chunking.ts so behavior is
 * byte-identical before/after the Phase 2 refactor:
 *  - class field / private syntax always on
 *  - legacy decorators always on
 *  - dynamic import / import attributes / top-level await always on
 *  - JSX only when `options.jsx` is true
 *  - TypeScript only when `options.language === 'typescript'`
 */
function buildPlugins(options: ParseOptions): ParserPlugin[] {
  const plugins: ParserPlugin[] = [
    'classProperties',
    'classPrivateProperties',
    'classPrivateMethods',
    'decorators-legacy',
    'dynamicImport',
    'importAttributes',
    'topLevelAwait',
  ];
  if (options.jsx) {
    plugins.push('jsx');
  }
  if (options.language === 'typescript') {
    plugins.push('typescript');
  }
  return plugins;
}

async function parse(content: string, options: ParseOptions): Promise<AstNode> {
  const { parse: babelParse } = await loadBabelParser();
  const ast = babelParse(content, {
    sourceType: 'module',
    plugins: buildPlugins(options),
    errorRecovery: options.errorRecovery,
    allowReturnOutsideFunction: true,
  });
  return ast as unknown as AstNode;
}

export const babelAdapter: ParserAdapter = {
  id: 'babel',
  parse,
};
