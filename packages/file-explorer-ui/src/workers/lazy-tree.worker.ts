/// <reference lib="webworker" />
import type { Filters, FlatRow, FromWorker, ToWorker, TreeNode } from '../types/lazy-tree';

let sourceTree: TreeNode[] = [];
const expanded = new Set<string>();
let filters: Filters = { include: [], exclude: [], useRegex: false, quick: '' };
let flatCache: FlatRow[] = [];

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  try {
    // Vite exposes import.meta.env.PROD in browser/worker
    // Fallback to NODE_ENV for non-Vite environments
    const metaEnv = (import.meta as unknown as { env?: { prod?: boolean } })?.env;

    const nodeEnv = 'NODE_ENV';
    const isProd =
      (typeof import.meta !== 'undefined' && !!(metaEnv as { prod?: boolean } | undefined)?.prod) ||
      (typeof process !== 'undefined' && process.env?.[nodeEnv] === 'production');
    return isProd ? 'Worker operation failed' : raw;
  } catch {
    return raw;
  }
}

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  try {
    const msg = e.data;
    switch (msg.type) {
      case 'SET_SOURCE_TREE':
        sourceTree = msg.tree ?? [];
        rebuild();
        postAck('SET_SOURCE_TREE');
        break;
      case 'SET_FILTERS':
        filters = msg.filters;
        rebuild();
        postAck('SET_FILTERS');
        break;
      case 'EXPAND':
        msg.paths.forEach((p) => expanded.add(p));
        rebuild();
        postAck('EXPAND');
        break;
      case 'COLLAPSE':
        msg.paths.forEach((p) => expanded.delete(p));
        rebuild();
        postAck('COLLAPSE');
        break;
      case 'RESET_EXPANSION':
        expanded.clear();
        rebuild();
        postAck('RESET_EXPANSION');
        break;
      case 'GET_RANGE': {
        const rows = flatCache.slice(msg.start, msg.end);
        post({ type: 'RANGE_DATA', start: msg.start, end: msg.end, rows });
        break;
      }
      case 'REBUILD':
        rebuild();
        postAck('REBUILD');
        break;
    }
  } catch (err) {
    post({ type: 'ERROR', message: safeErrorMessage(err), op: e.data?.type });
  }
};

function post(m: FromWorker) {
  ctx.postMessage(m);
}
function postAck(op: ToWorker['type']) {
  post({ type: 'ACK', for: op });
}

function rebuild(): void {
  const filtered = filterTree(sourceTree, filters);
  const { rows, stats } = flatten(filtered, expanded);
  flatCache = rows;
  post({ type: 'VISIBLE_LIST', rows, totalCount: rows.length });
  post({ type: 'STATS', ...stats });
}

function filterTree(tree: TreeNode[], f: Filters): TreeNode[] {
  if (!f.include.length && !f.exclude.length && !f.quick) return tree;
  const matchers = buildMatchers(f);
  const walk = (n: TreeNode): TreeNode | null => {
    const isMatch = matchers(n);
    if (n.type === 'file') return isMatch ? n : null;
    const kids = (n.children ?? []).map(walk).filter(Boolean) as TreeNode[];
    if (kids.length > 0 || isMatch) return { ...n, children: kids };
    return null;
  };
  return tree.map(walk).filter(Boolean) as TreeNode[];
}

function flatten(tree: TreeNode[], exp: Set<string>) {
  const rows: FlatRow[] = [];
  let files = 0;
  let dirs = 0;
  const filteredOut = 0; // reserved for future detailed stats

  const push = (n: TreeNode, depth: number) => {
    const children = n.children ?? [];
    const hasChildren = children.length > 0;
    rows.push({
      id: n.path,
      path: n.path,
      name: n.name,
      kind: n.type,
      depth,
      expanded: exp.has(n.path),
      hasChildren,
    });
    if (n.type === 'file') files++;
    else dirs++;
    if (n.type === 'directory' && hasChildren && exp.has(n.path)) {
      for (const c of children) push(c, depth + 1);
    }
  };
  tree.forEach((n) => push(n, 0));
  return { rows, stats: { total: rows.length, files, dirs, filteredOut } };
}

function buildMatchers(f: Filters) {
  const inc = f.include;
  const exc = f.exclude;
  const quick = f.quick?.toLowerCase() ?? '';
  if (f.useRegex) {
    const incRegex = inc.map((s) => new RegExp(s));
    const excRegex = exc.map((s) => new RegExp(s));
    return (n: TreeNode) => matchRegex(n, quick, incRegex, excRegex);
  }
  return (n: TreeNode) => matchIncludes(n, quick, inc, exc);
}

function matchRegex(n: TreeNode, quick: string, inc: RegExp[], exc: RegExp[]): boolean {
  const hay = `${n.name.toLowerCase()} ${n.path.toLowerCase()}`;
  if (quick && !hay.includes(quick)) return false;
  if (inc.length && !inc.some((r) => r.test(hay))) return false;
  if (exc.some((r) => r.test(hay))) return false;
  return true;
}

function matchIncludes(n: TreeNode, quick: string, inc: string[], exc: string[]): boolean {
  const hay = `${n.name.toLowerCase()} ${n.path.toLowerCase()}`;
  if (quick && !hay.includes(quick)) return false;
  if (inc.length && !inc.some((s) => hay.includes(s.toLowerCase()))) return false;
  if (exc.some((s) => hay.includes(s.toLowerCase()))) return false;
  return true;
}
