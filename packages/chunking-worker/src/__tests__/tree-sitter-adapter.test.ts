/**
 * Contract tests for the tree-sitter parser adapter (Phase 2 — skeleton).
 *
 * Phase 2 deliberately scopes the tests to the adapter *contract*, not the
 * grammar+query behavior that lands in Phase 3. The skeleton must:
 *  - expose a factory `treeSitterAdapter(language)` returning a `ParserAdapter`
 *  - identify itself as `'tree-sitter'` for telemetry routing
 *  - return an AstNode root whose `type` is defined and whose `start`/`end`
 *    span the entire source — even though Phase 2 doesn't yet emit any
 *    child nodes (those come from grammar-driven extraction in Phase 3).
 *
 * Why we don't assert "throws because not implemented":
 *  - The contract docstring (parsers/types.ts) says adapters MUST return a
 *    root with `type` defined. The cheapest honest implementation is a
 *    minimal placeholder root, not an `Error`. Phase 3's tests will then
 *    assert that the root *also* contains function/class nodes.
 *  - A throwing skeleton would force every Phase 3 test to also assert
 *    "no longer throws", which is noise. Better: Phase 2 satisfies the
 *    contract minimally; Phase 3 enriches the result.
 *
 * See: docs/prd-chunking-tree-sitter-2026-05.md §5.1 (Phase 2 row)
 */

import { describe, expect, it } from 'vitest';
import { treeSitterAdapter } from '../parsers/tree-sitter-adapter';
import type { ParseOptions } from '../parsers/types';

// `language` on ParseOptions is `'javascript' | 'typescript'`. The tree-sitter
// adapter ignores it (language is baked in at factory time via
// `treeSitterAdapter('python')`), so passing 'javascript' is a no-op here —
// kept for ParseOptions shape conformance only.
const baseOptions: ParseOptions = {
  errorRecovery: true,
  jsx: false,
  language: 'javascript',
};

describe('treeSitterAdapter (Phase 2 skeleton)', () => {
  it('identifies itself as the tree-sitter adapter', () => {
    const adapter = treeSitterAdapter('python');
    expect(adapter.id).toBe('tree-sitter');
  });

  it('returns a root AstNode with a defined type for non-empty source', async () => {
    const adapter = treeSitterAdapter('python');
    const root = await adapter.parse('def foo(): pass', baseOptions);

    // We deliberately don't pin the exact type string here. Phase 2 may pick
    // 'program' (matching tree-sitter's Python root node convention) but Phase
    // 3's real grammar-driven root might differ. What the contract requires —
    // and what consumers like `iterateAstChildren` actually depend on — is
    // that `type` is defined at all.
    expect(root.type).toBeDefined();
  });

  it('spans the entire source via start=0 and end=content.length', async () => {
    const content = 'def foo(): pass\ndef bar(): pass';
    const adapter = treeSitterAdapter('python');
    const root = await adapter.parse(content, baseOptions);

    expect(root.start).toBe(0);
    expect(root.end).toBe(content.length);
  });

  it('handles empty source without throwing', async () => {
    const adapter = treeSitterAdapter('python');
    const root = await adapter.parse('', baseOptions);

    expect(root.type).toBeDefined();
    expect(root.start).toBe(0);
    expect(root.end).toBe(0);
  });
});
