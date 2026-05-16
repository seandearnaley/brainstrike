/**
 * Differential test: Babel adapter vs oxc parser (Phase 6).
 *
 * The PRD §11 safety gate. For each fixture, parses with both adapters and
 * asserts that the *function-range set* (what the chunking consumer
 * actually depends on) is identical. We don't compare full ASTs — they
 * differ in shape (Babel: File→Program→body; oxc: Program→body) and that
 * difference is by design (Phase 3 Cycle 3.3 verified consumer
 * compatibility). What matters is whether the chunking pipeline ends up
 * cutting at the same byte offsets regardless of parser choice.
 *
 * Skip oxc-ipc-adapter for this test — the IPC layer is verified in
 * Phase 4. Here we're testing parser equivalence at the parsing layer
 * directly: babel via babelAdapter.parse(), oxc via oxc-parser.parseSync().
 *
 * If a fixture's chunk ranges diverge, that's either:
 *   (a) a real chunk-parity bug — fix it before merging, or
 *   (b) an expected divergence (e.g., oxc parses something Babel rejects)
 *       — document in differential.allowed-deltas.md and skip the case.
 *
 * See: docs/prd-chunking-wasm-parser-2026-05.md §11
 */

import { parseSync } from 'oxc-parser';
import { describe, expect, it } from 'vitest';
import { babelAdapter } from '../parsers/babel-adapter';
import type { AstNode, ParseOptions } from '../parsers/types';

// ─── Mirror of portable-chunking's collectTopLevelFunctionRanges ───
//
// We copy the logic exactly — not a simplified version — so the
// differential test asserts what the real chunking pipeline would do.
// If portable-chunking's logic ever changes, these mirror functions
// must be updated in lockstep (this is the brittle part; documented).

function isFunctionType(type?: string): boolean {
  return (
    type === 'FunctionDeclaration' ||
    type === 'FunctionExpression' ||
    type === 'ArrowFunctionExpression' ||
    type === 'ClassMethod' ||
    type === 'ClassPrivateMethod' ||
    type === 'ObjectMethod' ||
    type === 'MethodDefinition' ||
    type === 'TSDeclareFunction' ||
    type === 'TSFunctionType' ||
    type === 'TSMethodSignature' ||
    type === 'TSConstructSignatureDeclaration' ||
    type === 'TSCallSignatureDeclaration'
  );
}

function isTopLevelContainerType(type?: string): boolean {
  return (
    type === 'Program' ||
    type === 'ExportNamedDeclaration' ||
    type === 'ExportDefaultDeclaration' ||
    type === 'ClassBody'
  );
}

function isAstObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && 'type' in (value as object));
}

function iterateAstChildren(node: Record<string, unknown>): Record<string, unknown>[] {
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

function hasFunctionAncestor(ancestors: readonly Record<string, unknown>[]): boolean {
  return ancestors.some((a) =>
    isFunctionType(typeof a['type'] === 'string' ? (a['type'] as string) : undefined)
  );
}

interface Range {
  readonly end: number;
  readonly start: number;
}

function collectTopLevelFunctionRanges(
  node: Record<string, unknown> | null,
  ancestors: Record<string, unknown>[],
  ranges: Range[]
): void {
  if (!node) {
    return;
  }
  const nodeType = typeof node['type'] === 'string' ? (node['type'] as string) : '';
  const parentType =
    typeof ancestors.at(-1)?.['type'] === 'string'
      ? (ancestors.at(-1)?.['type'] as string)
      : undefined;
  if (
    isTopLevelContainerType(parentType) &&
    !hasFunctionAncestor(ancestors) &&
    isFunctionType(nodeType) &&
    typeof node['start'] === 'number' &&
    typeof node['end'] === 'number' &&
    Number.isFinite(node['start']) &&
    Number.isFinite(node['end'])
  ) {
    ranges.push({ end: node['end'] as number, start: node['start'] as number });
  }
  ancestors.push(node);
  for (const child of iterateAstChildren(node)) {
    collectTopLevelFunctionRanges(child, ancestors, ranges);
  }
  ancestors.pop();
}

function functionRanges(root: Record<string, unknown>): Range[] {
  const ranges: Range[] = [];
  collectTopLevelFunctionRanges(root, [], ranges);
  return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
}

// ─── Adapter helpers ───

function deriveOxcFilename(opts: ParseOptions): string {
  if (opts.language === 'typescript') {
    return opts.jsx ? 'src.tsx' : 'src.ts';
  }
  return opts.jsx ? 'src.jsx' : 'src.js';
}

async function parseWithBabel(content: string, opts: ParseOptions): Promise<AstNode> {
  return babelAdapter.parse(content, opts);
}

function parseWithOxc(content: string, opts: ParseOptions): AstNode {
  const result = parseSync(deriveOxcFilename(opts), content);
  return result.program as unknown as AstNode;
}

// ─── Fixture corpus ───

interface Fixture {
  /** Expected number of function ranges (sanity check independent of equivalence). */
  readonly expectedFunctionCount: number;
  readonly name: string;
  readonly options: ParseOptions;
  readonly source: string;
}

const baseJs: ParseOptions = { errorRecovery: true, jsx: false, language: 'javascript' };
const baseTs: ParseOptions = { errorRecovery: true, jsx: false, language: 'typescript' };
const baseTsx: ParseOptions = { errorRecovery: true, jsx: true, language: 'typescript' };

const fixtures: Fixture[] = [
  {
    expectedFunctionCount: 2,
    name: 'simple JS function declarations',
    options: baseJs,
    source: `
function alpha() { return 1; }
function beta() { return 2; }
`.trim(),
  },
  {
    expectedFunctionCount: 1,
    name: 'arrow function exported as default',
    options: baseJs,
    source: 'export default () => 42;',
  },
  {
    // Surprising count: 2, not 3. Top-level arrow assigned to a const has
    // VariableDeclarator as its immediate parent, not Program/ExportXxx/
    // ClassBody. The chunking consumer's `isTopLevelContainerType` check
    // (mirrored above) rejects VariableDeclarator, so arrows-in-const are
    // NOT chunked separately. They get folded into the surrounding
    // VariableDeclaration's chunk. Both parsers agree on this — it's a
    // chunking-behavior choice, not a parser difference.
    expectedFunctionCount: 2,
    name: 'mixed declarations + arrow-in-const + class methods',
    options: baseTs,
    source: `
function topLevel() {}
const arrow = () => 1;
class Foo {
  method() {}
}
`.trim(),
  },
  {
    expectedFunctionCount: 1,
    name: 'TS interface (no functions, types stripped)',
    options: baseTs,
    source: `
interface Shape { kind: 'a' | 'b'; size: number }
function area(s: Shape): number { return s.size; }
`.trim(),
  },
  {
    expectedFunctionCount: 1,
    name: 'TSX component',
    options: baseTsx,
    source: `
type Props = { name: string };
function Greet({ name }: Props) {
  return <span>{name}</span>;
}
`.trim(),
  },
  {
    expectedFunctionCount: 2,
    name: 'async + generator functions',
    options: baseJs,
    source: `
async function fetchData() { return await Promise.resolve(1); }
function* counter() { yield 1; yield 2; }
`.trim(),
  },
  {
    expectedFunctionCount: 3,
    name: 'class with constructor and methods',
    options: baseTs,
    source: `
class Service {
  constructor(private readonly name: string) {}
  greet() { return 'hi ' + this.name; }
  async fetch() { return await Promise.resolve(this.name); }
}
`.trim(),
  },
  {
    // The FunctionExpression's parent is CallExpression, not a top-level
    // container (Program/ExportXxx/ClassBody), so the consumer correctly
    // does NOT chunk at this function. Both parsers agree.
    expectedFunctionCount: 0,
    name: 'function expression in IIFE (not chunked — non-top-level)',
    options: baseJs,
    source: '(function() { return 1; })();',
  },
];

// ─── The differential assertion ───

describe('parser differential: babel vs oxc', () => {
  for (const fixture of fixtures) {
    it(`produces equivalent function ranges for: ${fixture.name}`, async () => {
      const babelTree = await parseWithBabel(fixture.source, fixture.options);
      const oxcTree = parseWithOxc(fixture.source, fixture.options);

      const babelRanges = functionRanges(babelTree as Record<string, unknown>);
      const oxcRanges = functionRanges(oxcTree as Record<string, unknown>);

      // Sanity: both parsers found the expected count of top-level functions
      // (matching the chunking consumer's "top-level container parent + no
      // function ancestor" predicate).
      expect(babelRanges).toHaveLength(fixture.expectedFunctionCount);
      expect(oxcRanges).toHaveLength(fixture.expectedFunctionCount);

      // The actual differential assertion: IDENTICAL byte ranges. Chunk
      // boundaries depend only on start/end, so this is what production
      // would care about. Type names differ between parsers (Babel:
      // ClassMethod, oxc: MethodDefinition) but neither end up in the
      // chunk output.
      expect(oxcRanges).toEqual(babelRanges);
    });
  }
});
