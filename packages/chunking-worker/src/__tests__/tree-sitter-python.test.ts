/**
 * Tree-sitter Python extraction tests (Phase 3 — grammar + query).
 *
 * Phase 2 (#999) shipped the contract-conformant skeleton; this phase wires
 * `web-tree-sitter` + a vendored `python.wasm` grammar + a `python.scm`
 * query that selects top-level function/class/decorated definitions.
 *
 * The contract reshape from Phase 2:
 *   skeleton.parse('def foo(): pass') →
 *     { type: 'program', start: 0, end: 17 }                  // no children
 *
 *   phase3.parse('def foo(): pass') →
 *     { type: 'module', start: 0, end: 17, children: [
 *       { type: 'function_definition', start: 0, end: 17, name: 'foo' }
 *     ]}
 *
 * Why the children are filtered to query matches (not the full tree):
 *  - The chunking consumer (`collectTopLevelFunctionRanges` in
 *    portable-chunking.ts) only cares about top-level function-like
 *    nodes. Emitting the full tree-sitter parse tree would bloat the
 *    AstNode payload with every identifier, operator, and comment for
 *    no consumer benefit.
 *  - Per-language queries (Python today; Rust/Go/Markdown later) define
 *    "what counts as a chunk" without touching the consumer.
 *
 * See: docs/prd-chunking-tree-sitter-2026-05.md §3.4, §5.1 (Phase 3 row)
 */

import { describe, expect, it } from 'vitest';
import { treeSitterAdapter } from '../parsers/tree-sitter-adapter';
import type { AstNode, ParseOptions } from '../parsers/types';

const baseOptions: ParseOptions = {
  errorRecovery: true,
  jsx: false,
  language: 'javascript',
};

/**
 * Type guard for AstNode children arrays. The contract says children are
 * stored on any field (the walker is duck-typed). The tree-sitter adapter
 * specifically uses `children: AstNode[]` for consistency.
 */
function children(root: AstNode): AstNode[] {
  const value = (root as { children?: unknown }).children;
  return Array.isArray(value) ? (value as AstNode[]) : [];
}

describe('treeSitterAdapter Python extraction (Phase 3)', () => {
  it('extracts a top-level function as a function_definition child', async () => {
    const content = 'def foo():\n    pass\n';
    const adapter = treeSitterAdapter('python');

    const root = await adapter.parse(content, baseOptions);
    const fn = children(root).find((c) => c.type === 'function_definition');

    expect(fn).toBeDefined();
    expect(fn?.start).toBe(0);
    expect(fn?.end).toBeGreaterThan(0);
  });

  it('extracts a top-level class as a class_definition child', async () => {
    const content = 'class Foo:\n    pass\n';
    const adapter = treeSitterAdapter('python');

    const root = await adapter.parse(content, baseOptions);
    const cls = children(root).find((c) => c.type === 'class_definition');

    expect(cls).toBeDefined();
    expect(cls?.start).toBe(0);
  });

  it('extracts a decorated function as a decorated_definition spanning the decorator', async () => {
    const content = '@my_decorator\ndef foo():\n    pass\n';
    const adapter = treeSitterAdapter('python');

    const root = await adapter.parse(content, baseOptions);
    const decorated = children(root).find((c) => c.type === 'decorated_definition');

    expect(decorated).toBeDefined();
    // The chunk MUST span the decorator (start at '@'), not just the
    // function body — otherwise the chunker would emit @my_decorator as
    // dangling source above the function chunk.
    expect(decorated?.start).toBe(0);
  });

  it('emits multiple top-level definitions in source order', async () => {
    const content = [
      'def foo():',
      '    pass',
      '',
      'class Bar:',
      '    pass',
      '',
      'def baz():',
      '    pass',
      '',
    ].join('\n');
    const adapter = treeSitterAdapter('python');

    const root = await adapter.parse(content, baseOptions);
    const types = children(root).map((c) => c.type);

    // Source-order matters: the chunking consumer assumes ranges are
    // non-overlapping and sorted by start position.
    expect(types).toEqual(['function_definition', 'class_definition', 'function_definition']);
  });

  it('does NOT emit nested functions (those are interior to their parent chunk)', async () => {
    const content = [
      'def outer():',
      '    def inner():',
      '        pass',
      '    return inner',
      '',
    ].join('\n');
    const adapter = treeSitterAdapter('python');

    const root = await adapter.parse(content, baseOptions);
    const fns = children(root).filter((c) => c.type === 'function_definition');

    // The inner function is part of the outer function's body — emitting
    // it as a separate top-level chunk would create overlapping ranges.
    expect(fns).toHaveLength(1);
    expect(fns[0]?.start).toBe(0);
  });

  it('handles syntactically invalid Python via error recovery (returns best-effort root)', async () => {
    // tree-sitter is error-tolerant by design — it produces a tree even
    // for malformed input. The contract requires we don't throw when
    // errorRecovery: true, matching babelAdapter's behavior.
    const content = 'def foo(:\n    pass\n'; // missing `)` after `(`
    const adapter = treeSitterAdapter('python');

    const root = await adapter.parse(content, baseOptions);

    expect(root.type).toBeDefined();
    expect(root.end).toBe(content.length);
  });
});
