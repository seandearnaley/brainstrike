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

import { type Language, Query, type Node as TsNode } from 'web-tree-sitter';
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
    '(module (function_definition name: (identifier) @name) @chunk)',
    '(module (class_definition name: (identifier) @name) @chunk)',
    '(module (decorated_definition (function_definition name: (identifier) @name)) @chunk)',
    '(module (decorated_definition (class_definition name: (identifier) @name)) @chunk)',
  ].join('\n'),
};

/**
 * Symbol-reference queries (BST-919), run as a SECOND pass so their captures
 * can never leak into the chunk-children contract. Calls and imports match at
 * any depth; results ride the root's `symbolRefs` field — names only, no
 * subtrees, honoring the bounded-payload rationale above.
 *
 * `aliased_import` (`from x import a as b`) is deliberately unmatched in v1;
 * a miss is an absent retrieval edge, not an error.
 */
const SYMBOL_QUERIES: Record<TreeSitterLanguage, string> = {
  python: [
    '(call function: (identifier) @call)',
    '(call function: (attribute attribute: (identifier) @call))',
    '(import_statement name: (dotted_name) @import_plain)',
    '(import_from_statement module_name: (dotted_name) @from_module name: (dotted_name) @from_name)',
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
 *
 * WeakMap keying ensures that if `resetLoaderForTests()` evicts a
 * Language, its compiled Query is also collected — no stale-reference
 * leak across test runs.
 */
const queryCache = new WeakMap<Language, { chunks: Query; symbols: Query }>();

function getOrCompileQueries(
  language: TreeSitterLanguage,
  lang: Language
): { chunks: Query; symbols: Query } {
  let queries = queryCache.get(lang);
  if (!queries) {
    queries = {
      chunks: new Query(lang, QUERIES[language]),
      symbols: new Query(lang, SYMBOL_QUERIES[language]),
    };
    queryCache.set(lang, queries);
  }
  return queries;
}

/**
 * Convert a single tree-sitter node into our AstNode contract shape.
 * We keep this small — only fields the chunker reads — to keep the
 * serialization cost (if these ever cross a worker boundary as plain
 * objects) bounded.
 */
function toAstNode(node: TsNode): AstNode {
  return {
    end: node.endIndex,
    start: node.startIndex,
    type: node.type,
  };
}

/** One raw ref per symbol-query match: calls carry the callee name; both
 * import statement forms normalize to {name, module}. */
function collectSymbolRefs(query: Query, root: TsNode): Record<string, unknown>[] {
  const refs: Record<string, unknown>[] = [];
  for (const match of query.matches(root)) {
    const byName = new Map(match.captures.map((capture) => [capture.name, capture.node]));
    const call = byName.get('call');
    if (call) {
      refs.push({ kind: 'call', name: call.text, start: call.startIndex });
      continue;
    }
    const plain = byName.get('import_plain');
    if (plain) {
      refs.push({ kind: 'import', module: plain.text, name: plain.text, start: plain.startIndex });
      continue;
    }
    const fromModule = byName.get('from_module');
    const fromName = byName.get('from_name');
    if (fromModule && fromName) {
      refs.push({
        kind: 'import',
        module: fromModule.text,
        name: fromName.text,
        start: fromName.startIndex,
      });
    }
  }
  return refs;
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
        const { chunks, symbols } = getOrCompileQueries(language, lang);
        const matches = chunks.matches(tree.rootNode);

        // One child per MATCH, not per capture: since the chunk patterns
        // gained `@name` captures (BST-919), pushing every capture would turn
        // each definition's identifier into a phantom chunk boundary. The
        // `@chunk` capture is the child; `@name` annotates it. The identifier's
        // PARENT distinguishes decorated functions from decorated classes,
        // which the decorated_definition chunk type alone cannot.
        const children: AstNode[] = [];
        for (const match of matches) {
          const chunkNode = match.captures.find((capture) => capture.name === 'chunk')?.node;
          if (!chunkNode) {
            continue;
          }
          const child = toAstNode(chunkNode);
          const nameNode = match.captures.find((capture) => capture.name === 'name')?.node;
          if (nameNode) {
            child['name'] = nameNode.text;
            child['definitionType'] = nameNode.parent?.type;
          }
          children.push(child);
        }

        // Second pass: name-only call/import references for the symbol graph.
        // Deliberately NOT children — splitCodeByFunctions consumes children
        // as chunk ranges (pinned by extract-symbols.test.ts).
        const symbolRefs = collectSymbolRefs(symbols, tree.rootNode);

        return {
          children,
          end: content.length,
          start: 0,
          symbolRefs,
          type: ROOT_TYPES[language],
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
