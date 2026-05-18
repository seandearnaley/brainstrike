/**
 * Tree-sitter parser adapter — Phase 3 (Python grammar + query extraction).
 *
 * Phase 2 (#999) shipped a contract-conformant skeleton with a placeholder
 * root. This phase wires `web-tree-sitter` + a vendored `python.wasm`
 * grammar + a per-language query that extracts top-level function/class/
 * decorated definitions as AstNode children.
 *
 * Why factory-style:
 *  - Each tree-sitter language has its own ~250-500 KB WASM grammar.
 *  - `selectAdapter(filename)` (Phase 5) resolves once per extension; the
 *    resulting adapter caches its grammar via the module-level cache in
 *    `tree-sitter-grammar-loader.ts`.
 *
 * Why we emit only query-matched children (not the full parse tree):
 *  - The chunking consumer (`collectTopLevelFunctionRanges` in
 *    portable-chunking.ts) only cares about top-level function-like nodes.
 *  - The full parse tree contains every identifier/operator/comment —
 *    converting it to AstNode shape would balloon the payload for zero
 *    consumer benefit.
 *  - Per-language `.scm` queries define "what counts as a chunk" without
 *    touching the consumer.
 *
 * See: docs/prd-chunking-tree-sitter-2026-05.md §3.2, §3.4
 */

import { Query, type Node as TsNode } from 'web-tree-sitter';
import { loadLanguage } from './tree-sitter-grammar-loader';
import type { AstNode, ParseOptions, ParserAdapter } from './types';

/**
 * Languages this adapter understands. Phase 1 ships Python only; follow-on
 * PRDs add Rust, Go, Markdown, etc.
 */
export type TreeSitterLanguage = 'python';

/**
 * Per-language extraction queries. The string here MUST stay in sync with
 * the canonical `.scm` file at `parsers/tree-sitter-queries/<lang>.scm` —
 * the .scm is the human-readable reference; this constant is what the
 * bundled worker actually ships (since reading .scm files at runtime
 * requires either fs access or a bundler loader). A later phase can
 * deduplicate via a tsup raw-text loader if the language list grows.
 */
const QUERIES: Record<TreeSitterLanguage, string> = {
  python: [
    '(module (function_definition) @chunk)',
    '(module (class_definition) @chunk)',
    '(module (decorated_definition) @chunk)',
  ].join('\n'),
};

/**
 * Per-language root node type as the grammar reports it. Used as the
 * AstNode root's `type` so consumers that branch on root type (none yet,
 * but the contract reserves the option) see grammar-faithful values.
 */
const ROOT_TYPES: Record<TreeSitterLanguage, string> = {
  python: 'module',
};

/**
 * Cache one compiled Query per language, keyed by the loaded Language
 * instance. Compiling a Query is cheap relative to loading the WASM
 * grammar, but still worth caching since every parse re-runs it.
 */
const queryCache = new WeakMap<object, Query>();

function getOrCompileQuery(language: TreeSitterLanguage, lang: object): Query {
  let query = queryCache.get(lang);
  if (!query) {
    query = new Query(lang as never, QUERIES[language]);
    queryCache.set(lang, query);
  }
  return query;
}

/**
 * Convert a single tree-sitter node into our AstNode contract shape.
 * We keep this small — only fields the chunker reads — to keep the
 * serialization cost (if these ever cross a worker boundary as plain
 * objects) bounded.
 */
function toAstNode(node: TsNode): AstNode {
  return {
    type: node.type,
    start: node.startIndex,
    end: node.endIndex,
  };
}

/**
 * Construct a tree-sitter ParserAdapter bound to a specific language.
 *
 * The first `parse()` call per process pays the WASM-instantiate cost
 * (~10-30 ms typical). Subsequent calls reuse the cached Parser instance
 * via the module-level cache in tree-sitter-grammar-loader.ts.
 *
 * @param language - the tree-sitter language this adapter handles
 */
export function treeSitterAdapter(language: TreeSitterLanguage): ParserAdapter {
  return {
    id: 'tree-sitter',
    async parse(content: string, _options: ParseOptions): Promise<AstNode> {
      const lang = await loadLanguage(language);

      // Each adapter instance gets its own Parser — Parsers aren't safe
      // to share across concurrent parse calls. Language instances ARE
      // safe to share (and we cache them in the grammar loader).
      const { Parser } = await import('web-tree-sitter');
      const parser = new Parser();
      parser.setLanguage(lang);

      const tree = parser.parse(content);
      if (!tree) {
        // tree-sitter returns null only when the parser was cancelled or
        // misconfigured. Treat as a parse failure to match contract
        // semantics (caller's catch-block falls back to recursive chunker).
        throw new Error('tree-sitter returned null tree');
      }

      try {
        const query = getOrCompileQuery(language, lang);
        const matches = query.matches(tree.rootNode);

        // Each capture in matches is a top-level chunk. The query patterns
        // all bind the same capture name (`@chunk`); matches arrive in
        // source order because the grammar walk is in-order. We map each
        // capture to an AstNode child.
        const children: AstNode[] = [];
        for (const match of matches) {
          for (const capture of match.captures) {
            children.push(toAstNode(capture.node));
          }
        }

        return {
          type: ROOT_TYPES[language],
          start: 0,
          end: content.length,
          children,
        };
      } finally {
        // Parser holds native resources; delete frees them. Language and
        // Query are cached at module scope and outlive this call.
        tree.delete();
        parser.delete();
      }
    },
  };
}
