/**
 * Symbol extraction (BST-919 / BST-931).
 *
 * Both suites parse REAL source with the REAL adapters — the Babel adapter for
 * JS/TS (same ESTree shape oxc ships across IPC, so the extractor is proven
 * engine-agnostic by construction) and the tree-sitter WASM adapter for
 * Python. No hand-built ASTs: a hand-built fixture would just encode the
 * author's assumptions about node shapes, which is exactly the class of
 * assumption that has been wrong before in this pipeline (#992: oxc
 * MethodDefinition vs Babel ClassMethod).
 */

import { describe, expect, it } from 'vitest';
import { extractSymbols } from '../extract-symbols';
import { babelAdapter } from '../parsers/babel-adapter';
import { treeSitterAdapter } from '../parsers/tree-sitter-adapter';

const TS_FIXTURE = `
import { acquireLease } from './lease';
import defaultThing from 'node:worker_threads';
import * as ns from './ns';

export function startEmbeddingWorker(config: string): void {
  acquireLease(config);
  acquireLease(config);
  ns.spawn();
}

const helper = (x: number) => x + 1;

export const runAll = () => {
  startEmbeddingWorker('a');
};

export class WorkerPool extends BasePool implements Disposable {
  drain(): void {
    this.stop();
  }
}

export interface LeaseInfo { id: string }
export type LeaseId = string;
export enum Mode { A, B }

function outer(): void {
  function inner(): void {
    helper(1);
  }
  inner();
}

topLevelCall();
`;

async function parseTs(content: string) {
  const ast = await babelAdapter.parse(content, {
    errorRecovery: true,
    jsx: false,
    language: 'typescript',
  });
  return extractSymbols({ adapterId: 'babel', ast, content });
}

describe('extractSymbols — JS/TS (ESTree)', () => {
  it('extracts definitions with kind and exported-ness', async () => {
    const { symbols } = await parseTs(TS_FIXTURE);
    const byName = new Map(symbols.map((s) => [s.name, s]));

    expect(byName.get('startEmbeddingWorker')).toMatchObject({
      exported: true,
      kind: 'function',
    });
    // Arrow-const is how most TS code defines functions; classifying it as
    // 'variable' would make half the workspace invisible to caller queries.
    expect(byName.get('runAll')).toMatchObject({ exported: true, kind: 'function' });
    expect(byName.get('helper')).toMatchObject({ exported: false, kind: 'function' });
    expect(byName.get('WorkerPool')).toMatchObject({ exported: true, kind: 'class' });
    expect(byName.get('drain')).toMatchObject({ kind: 'method' });
    expect(byName.get('LeaseInfo')).toMatchObject({ kind: 'interface' });
    expect(byName.get('LeaseId')).toMatchObject({ kind: 'type' });
    expect(byName.get('Mode')).toMatchObject({ kind: 'enum' });
    expect(byName.get('outer')).toMatchObject({ exported: false, kind: 'function' });
    // Named nested functions are definitions too.
    expect(byName.get('inner')).toMatchObject({ kind: 'function' });
  });

  it('records source positions usable for range retrieval', async () => {
    const { symbols } = await parseTs(TS_FIXTURE);
    const worker = symbols.find((s) => s.name === 'startEmbeddingWorker');
    expect(worker).toBeDefined();
    const lines = TS_FIXTURE.split('\n');
    expect(lines[(worker?.startLine ?? 0) - 1]).toContain('export function startEmbeddingWorker');
    expect(worker && worker.endLine > worker.startLine).toBe(true);
    expect(
      worker && TS_FIXTURE.slice(worker.startOffset, worker.endOffset).includes('acquireLease')
    ).toBe(true);
  });

  it('extracts imports with their module specifier', async () => {
    const { refs } = await parseTs(TS_FIXTURE);
    const imports = refs.filter((ref) => ref.kind === 'import');
    expect(imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ module: './lease', name: 'acquireLease' }),
        expect.objectContaining({ module: 'node:worker_threads', name: 'defaultThing' }),
        expect.objectContaining({ module: './ns', name: 'ns' }),
      ])
    );
  });

  it('extracts call refs attributed to their ENCLOSING definition', async () => {
    const { refs, symbols } = await parseTs(TS_FIXTURE);
    const calls = refs.filter((ref) => ref.kind === 'call');

    const symbolName = (index: number | undefined) =>
      index === undefined ? undefined : symbols[index]?.name;

    const acquire = calls.find((ref) => ref.name === 'acquireLease');
    expect(symbolName(acquire?.enclosingSymbolIndex)).toBe('startEmbeddingWorker');

    // Member calls store the property name (receiver resolution is a stated
    // non-goal — the design trades precision for churn-stability).
    const spawn = calls.find((ref) => ref.name === 'spawn');
    expect(symbolName(spawn?.enclosingSymbolIndex)).toBe('startEmbeddingWorker');

    const workerCall = calls.find((ref) => ref.name === 'startEmbeddingWorker');
    expect(symbolName(workerCall?.enclosingSymbolIndex)).toBe('runAll');

    // Nearest enclosing def wins: helper(1) sits inside inner, not outer.
    const helperCall = calls.find((ref) => ref.name === 'helper');
    expect(symbolName(helperCall?.enclosingSymbolIndex)).toBe('inner');

    // Module-level code has no enclosing definition.
    const topLevel = calls.find((ref) => ref.name === 'topLevelCall');
    expect(topLevel?.enclosingSymbolIndex).toBeUndefined();
  });

  it('dedupes repeated calls within one enclosing definition', async () => {
    const { refs } = await parseTs(TS_FIXTURE);
    // acquireLease is called twice inside startEmbeddingWorker; one edge is
    // enough for traversal, and repeated expect()/log() calls would otherwise
    // dominate the table (the storage-cost gate in the design).
    const acquireCalls = refs.filter((ref) => ref.kind === 'call' && ref.name === 'acquireLease');
    expect(acquireCalls).toHaveLength(1);
  });

  it('extracts extends and implements as heritage refs', async () => {
    const { refs, symbols } = await parseTs(TS_FIXTURE);
    const heritage = refs.filter((ref) => ref.kind === 'extends' || ref.kind === 'implements');
    const pool = symbols.findIndex((s) => s.name === 'WorkerPool');
    expect(heritage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ enclosingSymbolIndex: pool, kind: 'extends', name: 'BasePool' }),
        expect.objectContaining({ kind: 'implements', name: 'Disposable' }),
      ])
    );
  });

  it('returns empty results for an AST with nothing extractable', async () => {
    const result = await parseTs('const enum_less = 1;\n');
    expect(result.symbols.filter((s) => s.kind !== 'variable')).toEqual([]);
    expect(result.refs).toEqual([]);
  });
});

const PY_FIXTURE = `import os.path
from collections import OrderedDict, defaultdict

def start_worker(config):
    lease = acquire_lease(config)
    return lease.renew()

def _private_helper():
    pass

@functools.cache
def cached_thing():
    return start_worker(None)

class WorkerPool:
    pass
`;

async function parsePy(content: string) {
  const ast = await treeSitterAdapter('python').parse(content, {
    errorRecovery: true,
    jsx: false,
    language: 'javascript',
  });
  return extractSymbols({ adapterId: 'tree-sitter', ast, content });
}

describe('extractSymbols — Python (tree-sitter)', () => {
  it('extracts top-level definitions; underscore prefix marks non-exported', async () => {
    const { symbols } = await parsePy(PY_FIXTURE);
    const byName = new Map(symbols.map((s) => [s.name, s]));

    // Python has no export syntax; the underscore convention is the honest
    // per-language mapping for the `exported` bit.
    expect(byName.get('start_worker')).toMatchObject({ exported: true, kind: 'function' });
    expect(byName.get('_private_helper')).toMatchObject({ exported: false, kind: 'function' });
    // Decorated definitions must not be invisible (their parent is
    // decorated_definition, not module — the .scm's own documented trap).
    expect(byName.get('cached_thing')).toMatchObject({ exported: true, kind: 'function' });
    expect(byName.get('WorkerPool')).toMatchObject({ exported: true, kind: 'class' });
  });

  it('extracts imports for both statement forms', async () => {
    const { refs } = await parsePy(PY_FIXTURE);
    const imports = refs.filter((ref) => ref.kind === 'import');
    expect(imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ module: 'os.path', name: 'os.path' }),
        expect.objectContaining({ module: 'collections', name: 'OrderedDict' }),
        expect.objectContaining({ module: 'collections', name: 'defaultdict' }),
      ])
    );
  });

  it('extracts calls attributed by offset containment', async () => {
    const { refs, symbols } = await parsePy(PY_FIXTURE);
    const calls = refs.filter((ref) => ref.kind === 'call');
    const symbolName = (index: number | undefined) =>
      index === undefined ? undefined : symbols[index]?.name;

    const acquire = calls.find((ref) => ref.name === 'acquire_lease');
    expect(symbolName(acquire?.enclosingSymbolIndex)).toBe('start_worker');

    // Attribute calls store the attribute name, same ruling as JS member calls.
    const renew = calls.find((ref) => ref.name === 'renew');
    expect(symbolName(renew?.enclosingSymbolIndex)).toBe('start_worker');

    const workerCall = calls.find((ref) => ref.name === 'start_worker');
    expect(symbolName(workerCall?.enclosingSymbolIndex)).toBe('cached_thing');
  });

  it('keeps the chunk-range contract unchanged: extraction adds no chunk children', async () => {
    // splitCodeByFunctions consumes root.children as chunk ranges. Symbol
    // extraction must ride SEPARATE fields, not new children — otherwise every
    // call/import would become a phantom chunk boundary.
    const ast = await treeSitterAdapter('python').parse(PY_FIXTURE, {
      errorRecovery: true,
      jsx: false,
      language: 'javascript',
    });
    const children = (ast as { children?: { type?: string }[] }).children ?? [];
    const childTypes = new Set(children.map((child) => child.type));
    expect(childTypes).toEqual(
      new Set(['function_definition', 'class_definition', 'decorated_definition'])
    );
  });
});

describe('extractSymbols — decoupled from chunking strategy (via chunkContent)', () => {
  // An interfaces-only module has NO function-shaped chunk ranges, so the
  // splitter falls back to separator chunking — but the parse and extraction
  // both succeeded, and discarding the symbols removed types.ts, constants.ts,
  // and barrel index.ts files from the graph entirely (#2032 review). The
  // import refs are the ones that bite: "who imports X" was missing exactly
  // the files whose whole job is importing.
  it('keeps symbols for an interfaces-only module that falls back to separator chunking', async () => {
    const { chunkContent } = await import('../portable-chunking');
    const content = [
      "import { Base } from './base';",
      'export interface LeaseInfo { id: string }',
      'export type LeaseId = string;',
      'export const MAX_LEASES = 8;',
      '',
    ].join('\n');

    const result = await chunkContent(content, {
      fileName: 'types.ts',
      filePath: 'src/types.ts',
      strategy: 'auto',
    });

    expect(result.skipped).toBe(false);
    expect(result.chunks.length).toBeGreaterThan(0);
    const symbolNames = (result.symbols ?? []).map((symbol) => symbol.name).sort();
    expect(symbolNames).toEqual(['LeaseId', 'LeaseInfo', 'MAX_LEASES']);
    expect(result.symbolRefs ?? []).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'import', name: 'Base' })])
    );
  });
});

describe('extractSymbols — class expressions', () => {
  it('records the extends edge of a class-valued const, attributed to the declarator', async () => {
    const { refs, symbols } = await parseTs(
      'export const Pool = class extends BasePool {};\nconst basePoolUser = new Pool();\n'
    );
    const pool = symbols.find((symbol) => symbol.name === 'Pool');
    expect(pool).toMatchObject({ exported: true, kind: 'class' });
    const heritage = refs.find((ref) => ref.kind === 'extends');
    expect(heritage).toMatchObject({ name: 'BasePool' });
    expect(symbols[heritage?.enclosingSymbolIndex ?? -1]?.name).toBe('Pool');
  });
});
