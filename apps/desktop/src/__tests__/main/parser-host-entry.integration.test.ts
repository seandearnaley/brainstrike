/**
 * Contract tests for the parser host's pure entry function.
 *
 * Cycle 3.1: identity + smoke parse.
 * Cycle 3.2: language/JSX/error-recovery matrix + defensive checks.
 *
 * Tests `handleParseRequest()` directly (no child-process spawn, no parentPort
 * mocking). Mirrors the unit-testable approach used by `db-host-entry.test.ts`,
 * which similarly separates pure logic from IPC plumbing.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §5 (Phase 3)
 */

import { describe, expect, it } from 'vitest';
import { handleParseRequest } from '../../parser-host-entry';
import { isParserHostParseResponse } from '../../parser-host-schema';
import type { ParserHostParseRequest } from '../../parser-host-shared';

const baseRequest: ParserHostParseRequest = {
  content: 'const x = 1',
  options: {
    errorRecovery: true,
    jsx: false,
    language: 'javascript',
  },
  requestId: 'test-1',
};

function expectOk(response: Awaited<ReturnType<typeof handleParseRequest>>) {
  expect(response.ok).toBe(true);
  if (!response.ok) {
    throw new Error(`expected ok response, got: ${response.error}`);
  }
  return response;
}

/**
 * Mirror of the chunking consumer's generic AST walk
 * (`iterateAstChildren` in packages/chunking-worker/src/portable-chunking.ts).
 *
 * Used by Cycle 3.3 tests below to verify that oxc's output is consumer-
 * compatible WITHOUT introducing a cross-package dependency from apps/desktop
 * tests into chunking-worker. Kept locally because copying ~10 lines of walk
 * logic is cheaper than exposing the predicate via a published export.
 */
function isAstObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && 'type' in (value as object));
}
function walkChildren(node: Record<string, unknown>): Record<string, unknown>[] {
  const children: Record<string, unknown>[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstObject(child)) {
          children.push(child);
        }
      }
    } else if (isAstObject(value)) {
      children.push(value);
    }
  }
  return children;
}
function findNodesByType(
  root: Record<string, unknown>,
  types: ReadonlySet<string>
): Array<{ type: string; start: number; end: number }> {
  const found: Array<{ type: string; start: number; end: number }> = [];
  const stack: Record<string, unknown>[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    const t = typeof node['type'] === 'string' ? (node['type'] as string) : '';
    if (types.has(t) && typeof node['start'] === 'number' && typeof node['end'] === 'number') {
      found.push({ end: node['end'] as number, start: node['start'] as number, type: t });
    }
    for (const child of walkChildren(node)) {
      stack.push(child);
    }
  }
  return found;
}

describe('handleParseRequest', () => {
  it('echoes the requestId on the response', async () => {
    const response = await handleParseRequest(baseRequest);

    expect(response.requestId).toBe('test-1');
  });

  it('returns ok: true with a typed root for a trivial JavaScript declaration', async () => {
    const response = await handleParseRequest(baseRequest);

    const ok = expectOk(response);
    expect(isParserHostParseResponse(response)).toBe(true);
    expect(typeof ok.root.type).toBe('string');
  });

  describe('language flag', () => {
    it('accepts TypeScript-only syntax when language is typescript', async () => {
      const response = await handleParseRequest({
        ...baseRequest,
        content: 'interface Foo { x: number }',
        options: { ...baseRequest.options, language: 'typescript' },
      });

      const ok = expectOk(response);
      expect(typeof ok.root.type).toBe('string');
    });

    it('rejects TypeScript-only syntax when language is javascript and errorRecovery is off', async () => {
      const response = await handleParseRequest({
        ...baseRequest,
        content: 'interface Foo { x: number }',
        options: { ...baseRequest.options, errorRecovery: false, language: 'javascript' },
      });

      expect(response.ok).toBe(false);
    });
  });

  describe('jsx flag', () => {
    it('accepts JSX when jsx is true', async () => {
      const response = await handleParseRequest({
        ...baseRequest,
        content: 'const el = <div>hi</div>',
        options: { ...baseRequest.options, jsx: true },
      });

      expectOk(response);
    });

    it('rejects JSX when jsx is false and errorRecovery is off', async () => {
      const response = await handleParseRequest({
        ...baseRequest,
        content: 'const el = <div>hi</div>',
        options: { ...baseRequest.options, errorRecovery: false, jsx: false },
      });

      expect(response.ok).toBe(false);
    });
  });

  describe('errorRecovery flag', () => {
    // oxc differs from Babel: oxc *always* recovers and returns a Program,
    // surfacing errors via result.errors. Our adapter applies the flag
    // semantically: errorRecovery=true → return tree even with errors;
    // errorRecovery=false → translate error count > 0 into a failure response.
    const malformed = 'const x = 1\nfoo bar baz\nconst y = 2';

    it('returns a tree on malformed input when errorRecovery is true', async () => {
      const response = await handleParseRequest({
        ...baseRequest,
        content: malformed,
      });

      expectOk(response);
    });

    it('returns failure on malformed input when errorRecovery is false', async () => {
      const response = await handleParseRequest({
        ...baseRequest,
        content: malformed,
        options: { ...baseRequest.options, errorRecovery: false },
      });

      expect(response.ok).toBe(false);
      if (response.ok) {
        throw new Error('expected failure response');
      }
      expect(response.error).toBeTruthy();
    });
  });

  describe('chunking-consumer compatibility (Cycle 3.3)', () => {
    // Cycle 3.3 verification: the chunking consumer walks the AST generically
    // and looks for function-shaped nodes with finite start/end. We pin the
    // assumption that oxc's output satisfies this contract WITHOUT any
    // normalization step. If these tests ever fail, it means oxc changed
    // its emit shape and we need an adapter-level normalization layer.

    const FUNCTION_TYPES: ReadonlySet<string> = new Set([
      'FunctionDeclaration',
      'FunctionExpression',
      'ArrowFunctionExpression',
      'ClassMethod',
      'MethodDefinition',
    ]);

    it('produces a tree with discoverable FunctionDeclaration nodes carrying finite start/end', async () => {
      const source = `
        function alpha() { return 1; }
        function beta() { return 2; }
        const gamma = () => alpha() + beta();
      `.trim();

      const response = await handleParseRequest({
        ...baseRequest,
        content: source,
      });
      const ok = expectOk(response);

      const found = findNodesByType(ok.root as unknown as Record<string, unknown>, FUNCTION_TYPES);

      // Two FunctionDeclarations + one ArrowFunctionExpression.
      const decls = found.filter((n) => n.type === 'FunctionDeclaration');
      const arrows = found.filter((n) => n.type === 'ArrowFunctionExpression');
      expect(decls).toHaveLength(2);
      expect(arrows).toHaveLength(1);

      // Spans are sane (start < end, within source bounds).
      for (const node of found) {
        expect(node.start).toBeGreaterThanOrEqual(0);
        expect(node.end).toBeLessThanOrEqual(source.length);
        expect(node.start).toBeLessThan(node.end);
      }
    });

    it('produces a Program-rooted tree (not File-rooted like Babel)', async () => {
      // Pinning the known shape difference. The chunking consumer is shape-
      // agnostic (walks parents generically), so this difference is fine —
      // but documenting it here means anyone investigating chunk parity
      // failures in Phase 6 can rule it out as a cause.
      const response = await handleParseRequest({
        ...baseRequest,
        content: 'function foo() {}',
      });
      const ok = expectOk(response);

      expect(ok.root.type).toBe('Program');
    });
  });

  describe('perf smoke (Cycle 3.4)', () => {
    // Sanity check, not the real benchmark (Phase 7 owns benchmarking against
    // a real codebase). The threshold is deliberately loose: if parsing 100
    // small files takes longer than this, something is very wrong (e.g. a
    // future regression made every parse synchronously load oxc-parser).
    //
    // We use a per-file budget rather than a total budget so the assertion
    // scales with corpus size. 5ms/file leaves orders of magnitude of
    // headroom over oxc's actual ~50µs/file on this kind of input.
    it('parses 100 small files within budget', async () => {
      const source = `
        function alpha() { return 1; }
        function beta() { return 2; }
        export const gamma = () => alpha() + beta();
        class Delta {
          constructor(private readonly x: number) {}
          method() { return this.x; }
        }
      `.trim();

      const startMs = performance.now();
      const responses = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          handleParseRequest({
            content: source,
            options: {
              errorRecovery: true,
              jsx: false,
              language: 'typescript',
            },
            requestId: `perf-${i}`,
          })
        )
      );
      const elapsedMs = performance.now() - startMs;

      // All parses succeeded
      for (const r of responses) {
        expect(r.ok).toBe(true);
      }

      // 5ms per file budget. oxc actually does ~50µs/file on inputs this size,
      // so this leaves ~100x headroom. If this ever fails, suspect:
      //   - oxc-parser was replaced with a slow JS parser
      //   - handleParseRequest grew an unintended I/O step
      //   - the test environment lost native NAPI support
      expect(elapsedMs).toBeLessThan(100 * 5);
    });
  });

  describe('defensive', () => {
    it('returns success on empty input even with errorRecovery off (oxc treats empty as valid Program)', async () => {
      // Empty input is technically valid (a Program with no body), so this
      // should still succeed. The test pins the behavior so we notice if oxc
      // ever changes its empty-input handling.
      const response = await handleParseRequest({
        ...baseRequest,
        content: '',
        options: { ...baseRequest.options, errorRecovery: false },
      });

      expectOk(response);
    });

    it('preserves the requestId across error responses', async () => {
      const response = await handleParseRequest({
        ...baseRequest,
        content: 'interface Bad { }',
        options: { ...baseRequest.options, errorRecovery: false, language: 'javascript' },
        requestId: 'unique-error-id',
      });

      expect(response.requestId).toBe('unique-error-id');
    });
  });
});
