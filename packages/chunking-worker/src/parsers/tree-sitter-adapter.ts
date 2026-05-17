/**
 * Tree-sitter parser adapter — Phase 2 skeleton.
 *
 * Phase 2 wires up the factory + ParserAdapter contract without yet loading
 * any grammar or executing any query. The skeleton returns a minimal root
 * AstNode that satisfies the contract; Phase 3 replaces the body with real
 * `web-tree-sitter` grammar loading and S-expression query-driven extraction
 * of function/class chunks.
 *
 * Why factory-style instead of a singleton:
 *  - Each tree-sitter language has its own WASM grammar (~200-300 KB).
 *  - `selectAdapter(filename)` resolves once per extension; the resulting
 *    adapter caches its grammar internally across many parses.
 *  - Singleton + per-call language flag would force a `switch (language)`
 *    inside `parse()`, plus loading every grammar eagerly to keep parse
 *    sync. Factory-time binding sidesteps both.
 *
 * Routing into this adapter happens in Phase 5 (selectAdapter extension);
 * Phase 2 only ships the type-correct skeleton + contract test.
 *
 * See: docs/prd-chunking-tree-sitter-2026-05.md §3.2, §5.1
 */

import type { AstNode, ParseOptions, ParserAdapter } from './types';

/**
 * Languages this adapter understands. Phase 1 ships Python only; follow-on
 * PRDs add Rust, Go, Markdown, etc.
 */
export type TreeSitterLanguage = 'python';

/**
 * Construct a tree-sitter ParserAdapter bound to a specific language.
 *
 * Phase 2: returns a skeleton adapter whose `parse()` produces a placeholder
 * root spanning the entire source. Satisfies the contract — type defined,
 * start=0, end=content.length — without yet loading a grammar.
 *
 * @param _language - the tree-sitter language this adapter handles.
 *                    Stored for Phase 3 grammar loading; unused in Phase 2.
 */
export function treeSitterAdapter(_language: TreeSitterLanguage): ParserAdapter {
  return {
    id: 'tree-sitter',
    parse: (content: string, _options: ParseOptions): Promise<AstNode> => {
      // Phase 2 placeholder: a typed root with no children. Phase 3 will
      // populate this with the real tree-sitter parse result, including
      // function_definition / class_definition / decorated_definition
      // nodes extracted via the per-language .scm query.
      return Promise.resolve({
        type: 'program',
        start: 0,
        end: content.length,
      });
    },
  };
}
