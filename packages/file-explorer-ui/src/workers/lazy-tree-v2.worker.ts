/// <reference lib="webworker" />
import type {
  FilterSpec,
  InboundMessage,
  OutboundMessage,
  TreeNode,
  VisibleRow,
  VisibleSplice,
} from '../lazy-tree-protocol';
import { computeVisibleRows } from '../visible-rows';

let sourceTree: TreeNode[] = [];
let expandedPaths = new Set<string>();
let currentFilter: FilterSpec | undefined;
let lastVisible: VisibleRow[] = [];

function post<T>(msg: OutboundMessage<T>) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Produce a single splice diff between old and new visible rows. */
function singleSpliceDiff(oldRows: VisibleRow[], newRows: VisibleRow[]): VisibleSplice[] {
  // Fast path: identical
  if (oldRows.length === newRows.length) {
    let same = true;
    for (let i = 0; i < oldRows.length; i++) {
      const oldRow = oldRows[i];
      const newRow = newRows[i];
      if (!oldRow || !newRow || oldRow.path !== newRow.path) {
        same = false;
        break;
      }
    }
    if (same) return [];
  }

  // Prefix
  let start = 0;
  while (
    start < oldRows.length &&
    start < newRows.length &&
    oldRows[start] &&
    newRows[start] &&
    oldRows[start]?.path === newRows[start]?.path
  ) {
    start++;
  }

  // Suffix
  let endOld = oldRows.length - 1;
  let endNew = newRows.length - 1;
  while (
    endOld >= start &&
    endNew >= start &&
    oldRows[endOld] &&
    newRows[endNew] &&
    oldRows[endOld]?.path === newRows[endNew]?.path
  ) {
    endOld--;
    endNew--;
  }

  const deleteCount = Math.max(0, endOld - start + 1);
  const items = newRows.slice(start, endNew + 1);
  return [{ index: start, deleteCount, items }];
}

function ack<T>(reqId: number, type: OutboundMessage['type'], payload?: T) {
  post({ reqId, type, payload });
}

function error(reqId: number, err: unknown) {
  post({ reqId, type: 'ERROR', error: err instanceof Error ? err.message : String(err) });
}

type InitPayload = { tree?: TreeNode[]; expanded?: string[]; filter?: FilterSpec };
type ReplacePayload = { tree?: TreeNode[] };
type PathPayload = { path?: string };
type FilterPayload = { filter?: FilterSpec };

function handle(msg: InboundMessage) {
  const { reqId, type } = msg;
  const t0 = now();

  try {
    switch (type) {
      case 'INIT_TREE': {
        const p = (msg.payload as InitPayload) ?? {};
        sourceTree = (p.tree ?? []) as TreeNode[];
        expandedPaths = new Set<string>(p.expanded ?? []);
        currentFilter = p.filter as FilterSpec | undefined;
        lastVisible = computeVisibleRows(sourceTree, expandedPaths, currentFilter);
        const calcMs = now() - t0;
        ack(reqId, 'VISIBLE_FULL', {
          rows: lastVisible,
          metrics: { calcMs, visibleCount: lastVisible.length, spliceCount: 0 },
        });
        break;
      }
      case 'REPLACE_TREE': {
        const p = (msg.payload as ReplacePayload) ?? {};
        sourceTree = (p.tree ?? []) as TreeNode[];
        // keep expansion + filter
        const rows = computeVisibleRows(sourceTree, expandedPaths, currentFilter);
        const splices = singleSpliceDiff(lastVisible, rows);
        lastVisible = rows;
        const calcMs = now() - t0;
        ack(reqId, splices.length ? 'VISIBLE_SPLICES' : 'VISIBLE_FULL', {
          splices,
          rows,
          metrics: { calcMs, visibleCount: rows.length, spliceCount: splices.length || 0 },
        });
        break;
      }
      case 'EXPAND': {
        const path = String((msg.payload as PathPayload)?.path || '');
        expandedPaths.add(path);
        const rows = computeVisibleRows(sourceTree, expandedPaths, currentFilter);
        const splices = singleSpliceDiff(lastVisible, rows);
        lastVisible = rows;
        const calcMs = now() - t0;
        ack(reqId, 'VISIBLE_SPLICES', {
          splices,
          metrics: { calcMs, visibleCount: rows.length, spliceCount: splices.length },
        });
        break;
      }
      case 'COLLAPSE': {
        const path = String((msg.payload as PathPayload)?.path || '');
        expandedPaths.delete(path);
        const rows = computeVisibleRows(sourceTree, expandedPaths, currentFilter);
        const splices = singleSpliceDiff(lastVisible, rows);
        lastVisible = rows;
        const calcMs = now() - t0;
        ack(reqId, 'VISIBLE_SPLICES', {
          splices,
          metrics: { calcMs, visibleCount: rows.length, spliceCount: splices.length },
        });
        break;
      }
      case 'APPLY_FILTER': {
        currentFilter = (msg.payload as FilterPayload)?.filter as FilterSpec | undefined;
        const rows = computeVisibleRows(sourceTree, expandedPaths, currentFilter);
        const splices = singleSpliceDiff(lastVisible, rows);
        lastVisible = rows;
        const calcMs = now() - t0;
        // Start with FULL if you prefer; SPLICES keeps the UI steady.
        ack(reqId, 'VISIBLE_SPLICES', {
          splices,
          metrics: { calcMs, visibleCount: rows.length, spliceCount: splices.length },
        });
        break;
      }
      case 'FULL_VISIBLE': {
        const rows = computeVisibleRows(sourceTree, expandedPaths, currentFilter);
        lastVisible = rows;
        const calcMs = now() - t0;
        ack(reqId, 'VISIBLE_FULL', {
          rows,
          metrics: { calcMs, visibleCount: rows.length, spliceCount: 0 },
        });
        break;
      }
      case 'PING': {
        ack(reqId, 'PONG', { t: now() });
        break;
      }
      default:
        throw new Error(`Unknown req type: ${type}`);
    }
  } catch (e) {
    error(reqId, e);
  }
}

(self as unknown as DedicatedWorkerGlobalScope).onmessage = (ev: MessageEvent<InboundMessage>) => {
  handle(ev.data);
};
