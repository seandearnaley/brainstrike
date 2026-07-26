/**
 * Symbol extraction for the symbol graph (BST-919 / BST-931).
 *
 * Runs at chunking time, on the AST the chunker ALREADY has in hand — the
 * design requirement is no separate walker, so both index paths (initial sync
 * and edit reindex) get symbols by construction.
 *
 * Two source shapes, one output contract:
 *
 * - **ESTree** (oxc via the parser host on desktop, Babel on web): the full
 *   Program crosses the adapter boundary with every identifier intact, so this
 *   module walks it generically. One extractor, two engines — Babel and oxc
 *   emit the same fields for everything read here (the #992 lesson: where they
 *   differ, e.g. `ClassMethod` vs `MethodDefinition`, BOTH spellings are
 *   handled explicitly).
 * - **tree-sitter** (Python): the adapter deliberately ships a bounded
 *   synthetic tree, not the full parse. Definitions arrive as annotated chunk
 *   children (`name`, `definitionType`); calls and imports arrive on the
 *   root's `symbolRefs` field. Enclosing definitions are attributed by offset
 *   containment because there is no ancestry to walk.
 *
 * Refs reference their enclosing definition by INDEX into the returned
 * `symbols` array — ids are assigned at insert time by the port, keeping this
 * module persistence-free.
 */

import { buildLineStartOffsets, findLineForOffset } from './line-offsets';
import type { AstNode } from './parsers/types';

export type PortableSymbolKind =
  | 'class'
  | 'enum'
  | 'function'
  | 'interface'
  | 'method'
  | 'type'
  | 'variable';

export type PortableSymbolRefKind = 'call' | 'extends' | 'implements' | 'import';

export interface PortableSymbol {
  endLine: number;
  endOffset: number;
  exported: boolean;
  kind: PortableSymbolKind;
  name: string;
  startLine: number;
  startOffset: number;
}

export interface PortableSymbolRef {
  /** Index into the sibling `symbols` array; undefined = module level. */
  enclosingSymbolIndex?: number;
  kind: PortableSymbolRefKind;
  line: number;
  /** Import source specifier; imports only. */
  module?: string;
  name: string;
}

export interface ExtractedSymbols {
  refs: PortableSymbolRef[];
  symbols: PortableSymbol[];
}

interface ExtractArgs {
  adapterId: 'babel' | 'oxc-native' | 'tree-sitter';
  ast: AstNode;
  content: string;
}

export function extractSymbols(args: ExtractArgs): ExtractedSymbols {
  const lineStarts = buildLineStartOffsets(args.content);
  const line = (offset: number): number => findLineForOffset(lineStarts, offset);
  return args.adapterId === 'tree-sitter'
    ? extractFromTreeSitter(args.ast, line)
    : extractFromEstree(args.ast, line);
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** Dedupes refs per (enclosing, kind, name, module): one edge is enough for
 * traversal, and without this, repeated `expect()`/`log()` calls would
 * dominate the table — the storage-cost gate in the design. */
class RefCollector {
  readonly refs: PortableSymbolRef[] = [];
  private readonly seen = new Set<string>();

  add(ref: PortableSymbolRef): void {
    const key = `${ref.enclosingSymbolIndex ?? 'm'}|${ref.kind}|${ref.name}|${ref.module ?? ''}`;
    if (this.seen.has(key)) {
      return;
    }
    this.seen.add(key);
    this.refs.push(ref);
  }
}

function isNode(value: unknown): value is AstNode {
  return Boolean(value && typeof value === 'object' && 'type' in (value as object));
}

function nodeSpan(node: AstNode): { end: number; start: number } | null {
  const { start, end } = node;
  if (typeof start !== 'number' || typeof end !== 'number') {
    return null;
  }
  return { end, start };
}

// ---------------------------------------------------------------------------
// ESTree (oxc + Babel)
// ---------------------------------------------------------------------------

const FUNCTION_VALUED_INIT_TYPES = new Set(['ArrowFunctionExpression', 'FunctionExpression']);
const EXPORT_WRAPPER_TYPES = new Set(['ExportDefaultDeclaration', 'ExportNamedDeclaration']);
/** Babel spells class methods `ClassMethod`; oxc (ESTree) wraps them in
 * `MethodDefinition`. Both carry `key`. */
const METHOD_NODE_TYPES = new Set(['ClassMethod', 'MethodDefinition']);

const DECLARATION_KINDS = new Map<string, PortableSymbolKind>([
  ['ClassDeclaration', 'class'],
  ['FunctionDeclaration', 'function'],
  ['TSEnumDeclaration', 'enum'],
  ['TSInterfaceDeclaration', 'interface'],
  ['TSTypeAliasDeclaration', 'type'],
]);

function identifierName(node: unknown): string | undefined {
  if (!isNode(node)) {
    return;
  }
  const name = (node as { name?: unknown }).name;
  return node.type === 'Identifier' && typeof name === 'string' ? name : undefined;
}

function estreeChildren(node: AstNode): AstNode[] {
  const children: AstNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) {
          children.push(item);
        }
      }
    } else if (isNode(value)) {
      children.push(value);
    }
  }
  return children;
}

interface EstreeWalkState {
  readonly collector: RefCollector;
  /** Stack of indexes into `symbols` for enclosing definitions. */
  readonly enclosing: number[];
  readonly line: (offset: number) => number;
  readonly symbols: PortableSymbol[];
}

function pushSymbol(
  state: EstreeWalkState,
  node: AstNode,
  name: string,
  kind: PortableSymbolKind,
  exported: boolean
): number | null {
  const span = nodeSpan(node);
  if (!span) {
    return null;
  }
  state.symbols.push({
    endLine: state.line(Math.max(span.start, span.end - 1)),
    endOffset: span.end,
    exported,
    kind,
    name,
    startLine: state.line(span.start),
    startOffset: span.start,
  });
  return state.symbols.length - 1;
}

function isDirectlyExported(ancestors: readonly AstNode[]): boolean {
  const parent = ancestors.at(-1);
  return parent !== undefined && EXPORT_WRAPPER_TYPES.has(parent.type ?? '');
}

/** VariableDeclarator sits under VariableDeclaration; the export wrapper (if
 * any) is one level further up, and "top level" means the declaration's parent
 * chain reaches Program without an intervening function. */
function variableDeclaratorContext(ancestors: readonly AstNode[]): {
  exported: boolean;
  topLevel: boolean;
} {
  const declaration = ancestors.at(-1);
  const grandparent = ancestors.at(-2);
  if (declaration?.type !== 'VariableDeclaration') {
    return { exported: false, topLevel: false };
  }
  const container = grandparent?.type ?? '';
  return {
    exported: EXPORT_WRAPPER_TYPES.has(container),
    topLevel: container === 'Program' || EXPORT_WRAPPER_TYPES.has(container),
  };
}

function refLine(state: EstreeWalkState, node: AstNode): number {
  const span = nodeSpan(node);
  return span ? state.line(span.start) : 1;
}

function currentEnclosing(state: EstreeWalkState): number | undefined {
  return state.enclosing.at(-1);
}

function recordImportRefs(state: EstreeWalkState, node: AstNode): void {
  const source = (node as { source?: { value?: unknown } }).source;
  const module = typeof source?.value === 'string' ? source.value : undefined;
  const specifiers = (node as { specifiers?: unknown[] }).specifiers ?? [];
  for (const specifier of specifiers) {
    if (!isNode(specifier)) {
      continue;
    }
    // Named imports report the IMPORTED name (the graph joins on definition
    // names, and a local alias is invisible to the defining file); default and
    // namespace imports have only the local name.
    const imported = identifierName((specifier as { imported?: unknown }).imported);
    const local = identifierName((specifier as { local?: unknown }).local);
    const name = imported ?? local;
    if (!name) {
      continue;
    }
    const ref: PortableSymbolRef = {
      kind: 'import',
      line: refLine(state, specifier),
      name,
    };
    if (module !== undefined) {
      ref.module = module;
    }
    const enclosing = currentEnclosing(state);
    if (enclosing !== undefined) {
      ref.enclosingSymbolIndex = enclosing;
    }
    state.collector.add(ref);
  }
}

function recordCallRef(state: EstreeWalkState, node: AstNode): void {
  const callee = (node as { callee?: unknown }).callee;
  if (!isNode(callee)) {
    return;
  }
  // Identifier calls store the name; member calls store the PROPERTY name.
  // Receiver resolution is a stated non-goal — churn-stable name edges only.
  let name = identifierName(callee);
  if (name === undefined && callee.type === 'MemberExpression') {
    const computed = (callee as { computed?: unknown }).computed;
    if (computed !== true) {
      name = identifierName((callee as { property?: unknown }).property);
    }
  }
  if (!name) {
    return;
  }
  const ref: PortableSymbolRef = { kind: 'call', line: refLine(state, node), name };
  const enclosing = currentEnclosing(state);
  if (enclosing !== undefined) {
    ref.enclosingSymbolIndex = enclosing;
  }
  state.collector.add(ref);
}

function recordHeritageRefs(state: EstreeWalkState, node: AstNode, classIndex: number): void {
  const superClass = (node as { superClass?: unknown }).superClass;
  const superName = identifierName(superClass);
  if (superName) {
    state.collector.add({
      enclosingSymbolIndex: classIndex,
      kind: 'extends',
      line: refLine(state, node),
      name: superName,
    });
  }
  // Babel: `implements: TSExpressionWithTypeArguments[]`; oxc: `implements:
  // TSClassImplements[]`. Both carry `.expression`.
  const implemented = (node as { implements?: unknown[] }).implements ?? [];
  for (const entry of implemented) {
    if (!isNode(entry)) {
      continue;
    }
    const name = identifierName((entry as { expression?: unknown }).expression);
    if (name) {
      state.collector.add({
        enclosingSymbolIndex: classIndex,
        kind: 'implements',
        line: refLine(state, entry),
        name,
      });
    }
  }
}

/** Returns the symbol index this node defines, or null. */
function symbolForEstreeNode(
  state: EstreeWalkState,
  node: AstNode,
  ancestors: readonly AstNode[]
): number | null {
  const nodeType = node.type ?? '';

  const declarationKind = DECLARATION_KINDS.get(nodeType);
  if (declarationKind) {
    const name = identifierName((node as { id?: unknown }).id);
    if (!name) {
      return null;
    }
    return pushSymbol(state, node, name, declarationKind, isDirectlyExported(ancestors));
  }

  if (METHOD_NODE_TYPES.has(nodeType)) {
    const name = identifierName((node as { key?: unknown }).key);
    if (!name) {
      return null;
    }
    return pushSymbol(state, node, name, 'method', false);
  }

  if (nodeType === 'VariableDeclarator') {
    const context = variableDeclaratorContext(ancestors);
    if (!context.topLevel) {
      return null;
    }
    const name = identifierName((node as { id?: unknown }).id);
    if (!name) {
      return null;
    }
    const init = (node as { init?: unknown }).init;
    const kind: PortableSymbolKind =
      isNode(init) && FUNCTION_VALUED_INIT_TYPES.has(init.type ?? '') ? 'function' : 'variable';
    return pushSymbol(state, node, name, kind, context.exported);
  }

  return null;
}

function walkEstree(state: EstreeWalkState, node: AstNode, ancestors: AstNode[]): void {
  const nodeType = node.type ?? '';

  if (nodeType === 'ImportDeclaration') {
    recordImportRefs(state, node);
    return;
  }
  if (nodeType === 'CallExpression' || nodeType === 'NewExpression') {
    recordCallRef(state, node);
    // Fall through: arguments may contain calls and named function expressions.
  }

  const symbolIndex = symbolForEstreeNode(state, node, ancestors);
  if (symbolIndex !== null && (nodeType === 'ClassDeclaration' || nodeType === 'ClassExpression')) {
    recordHeritageRefs(state, node, symbolIndex);
  }

  if (symbolIndex !== null) {
    state.enclosing.push(symbolIndex);
  }
  ancestors.push(node);
  for (const child of estreeChildren(node)) {
    walkEstree(state, child, ancestors);
  }
  ancestors.pop();
  if (symbolIndex !== null) {
    state.enclosing.pop();
  }
}

function extractFromEstree(ast: AstNode, line: (offset: number) => number): ExtractedSymbols {
  const state: EstreeWalkState = {
    collector: new RefCollector(),
    enclosing: [],
    line,
    symbols: [],
  };
  walkEstree(state, ast, []);
  return { refs: state.collector.refs, symbols: state.symbols };
}

// ---------------------------------------------------------------------------
// tree-sitter (Python)
// ---------------------------------------------------------------------------

interface TreeSitterRawRef {
  kind?: unknown;
  module?: unknown;
  name?: unknown;
  start?: unknown;
}

function extractFromTreeSitter(ast: AstNode, line: (offset: number) => number): ExtractedSymbols {
  const symbols: PortableSymbol[] = [];
  const collector = new RefCollector();

  const rawChildren = ast['children'];
  const children = Array.isArray(rawChildren) ? rawChildren.filter(isNode) : [];
  for (const child of children) {
    const name = (child as { name?: unknown }).name;
    const span = nodeSpan(child);
    if (typeof name !== 'string' || name.length === 0 || !span) {
      continue;
    }
    const definitionType = (child as { definitionType?: unknown }).definitionType;
    symbols.push({
      endLine: line(Math.max(span.start, span.end - 1)),
      endOffset: span.end,
      // Python has no export syntax; the underscore convention is the honest
      // per-language mapping for this bit.
      exported: !name.startsWith('_'),
      kind: definitionType === 'class_definition' ? 'class' : 'function',
      name,
      startLine: line(span.start),
      startOffset: span.start,
    });
  }

  // The adapter cannot see ancestry (bounded payload), so a ref's enclosing
  // definition is the containing top-level def by offset. Defs are top-level
  // and disjoint, so "the last def whose span contains the offset" is exact.
  const enclosingByOffset = (offset: number): number | undefined => {
    for (let index = symbols.length - 1; index >= 0; index -= 1) {
      const candidate = symbols[index];
      if (candidate && candidate.startOffset <= offset && offset < candidate.endOffset) {
        return index;
      }
    }
    return;
  };

  const rawRefs = Array.isArray((ast as { symbolRefs?: unknown[] }).symbolRefs)
    ? ((ast as { symbolRefs?: unknown[] }).symbolRefs as TreeSitterRawRef[])
    : [];
  for (const raw of rawRefs) {
    if (typeof raw.name !== 'string' || raw.name.length === 0 || typeof raw.start !== 'number') {
      continue;
    }
    if (raw.kind !== 'call' && raw.kind !== 'import') {
      continue;
    }
    const ref: PortableSymbolRef = {
      kind: raw.kind,
      line: line(raw.start),
      name: raw.name,
    };
    if (typeof raw.module === 'string') {
      ref.module = raw.module;
    }
    const enclosing = enclosingByOffset(raw.start);
    if (enclosing !== undefined) {
      ref.enclosingSymbolIndex = enclosing;
    }
    collector.add(ref);
  }

  return { refs: collector.refs, symbols };
}
