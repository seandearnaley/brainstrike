/// <reference lib="webworker" />

/*
  Visible Rows Worker (V2)
  - Maintains an ID-based tree, current expansion set, and the visible order (array of NodeIds)
  - Computes splice patches for expand/collapse and full replacements for filter commits
*/

export type NodeId = number;

type InitMessage = {
  type: 'INIT';
  // Root ids in render order
  roots: Uint32Array;
  // Map of id -> children ids (Uint32Array serialized as object entries)
  childrenEntries: Array<{ id: NodeId; children: Uint32Array }>;
  // Node metadata (parallel arrays for structured clone efficiency)
  meta: {
    ids: Uint32Array;
    isDir: Uint8Array; // 1 for dir, 0 for file
    // Optional name for future filter logic
    names: string[];
    parent: Int32Array; // -1 for root
  };
};

type ToggleMessage = {
  type: 'EXPAND_TOGGLE';
  id: NodeId;
  expand: boolean;
};

type FilterCommitMessage = {
  type: 'FILTER_COMMIT';
  quick?: string;
};

type PrewarmMessage = {
  type: 'PREWARM_SUBTREE';
  id: NodeId;
};

type ToWorker = InitMessage | ToggleMessage | FilterCommitMessage | PrewarmMessage;

export type PatchOp = { at: number; del: number; ins: NodeId[] };
type PatchReply = {
  type: 'PATCH';
  ops: PatchOp[];
  workerMs: number;
  inserted: number;
  deleted: number;
};
type ReplaceReply = { type: 'REPLACE'; ids: NodeId[]; workerMs: number };
type AckReply = { type: 'ACK' };
type FromWorker = PatchReply | ReplaceReply | AckReply | { type: 'ERROR'; message: string };

// Internal state
const childrenById = new Map<NodeId, Uint32Array>();
let roots: Uint32Array = new Uint32Array();
let isDir: Uint8Array = new Uint8Array();
// Reserved for future filter logic (B2+)
// names reserved for future filter logic (not used in B1 worker)
// const names: string[] = [];
let parent: Int32Array = new Int32Array();
const expanded = new Set<NodeId>();
let visible: NodeId[] = [];
const idToIndex = new Map<NodeId, number>();

// Simple LRU cache for prewarmed subtrees
const prewarmCache = new Map<NodeId, NodeId[]>();
const prewarmOrder: NodeId[] = [];
const PREWARM_MAX = 5;

function lruSet(id: NodeId, list: NodeId[]): void {
  if (prewarmCache.has(id)) {
    // move to end
    const idx = prewarmOrder.indexOf(id);
    if (idx >= 0) prewarmOrder.splice(idx, 1);
  }
  prewarmCache.set(id, list);
  prewarmOrder.push(id);
  while (prewarmOrder.length > PREWARM_MAX) {
    const evict = prewarmOrder.shift();
    if (evict !== undefined) prewarmCache.delete(evict);
  }
}

function buildInitialVisible(): void {
  visible = [];
  idToIndex.clear();
  for (let i = 0; i < roots.length; i++) {
    const rid = roots[i] as NodeId;
    visible.push(rid);
    idToIndex.set(rid, visible.length - 1);
    if (isDir[rid] === 1 && expanded.has(rid)) {
      appendSubtree(rid);
    }
  }
}

function appendSubtree(parentId: NodeId): void {
  const stack: NodeId[] = [];
  const kids = childrenById.get(parentId) ?? new Uint32Array();
  for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as NodeId);
  while (stack.length) {
    const id = stack.pop() as NodeId;
    visible.push(id);
    idToIndex.set(id, visible.length - 1);
    if (isDir[id] === 1 && expanded.has(id)) {
      const ch = childrenById.get(id) ?? new Uint32Array();
      for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i] as NodeId);
    }
  }
}

function flattenForInsert(parentId: NodeId): NodeId[] {
  // Use prewarm cache if available
  const cached = prewarmCache.get(parentId);
  if (cached) return cached.slice();
  const out: NodeId[] = [];
  const kids = childrenById.get(parentId) ?? new Uint32Array();
  const stack: NodeId[] = [];
  for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as NodeId);
  while (stack.length) {
    const id = stack.pop() as NodeId;
    out.push(id);
    if (isDir[id] === 1 && expanded.has(id)) {
      const ch = childrenById.get(id) ?? new Uint32Array();
      for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i] as NodeId);
    }
  }
  return out;
}

function isDescendantOf(candidate: NodeId, ancestor: NodeId): boolean {
  let p = parent[candidate] as number;
  while (p !== -1) {
    if (p === ancestor) return true;
    p = parent[p] as number;
  }
  return false;
}

function collapseCountAfter(indexOfParent: number, parentId: NodeId): number {
  let count = 0;
  for (let i = indexOfParent + 1; i < visible.length; i++) {
    const vid = visible[i] as NodeId;
    if (!isDescendantOf(vid, parentId)) break;
    count++;
  }
  return count;
}

function handleInit(m: InitMessage): void {
  childrenById.clear();
  for (const entry of m.childrenEntries) childrenById.set(entry.id, entry.children);
  roots = m.roots;
  isDir = m.meta.isDir;
  // m.meta.names reserved for future filtering logic
  parent = m.meta.parent;
  expanded.clear();
  prewarmCache.clear();
  prewarmOrder.length = 0;
  buildInitialVisible();
}

function handleToggle(m: ToggleMessage): PatchReply {
  const start = performance.now();
  const id = m.id;
  const idx = idToIndex.get(id) ?? -1;
  if (idx === -1) return { type: 'PATCH', ops: [], workerMs: 0, inserted: 0, deleted: 0 };
  if (m.expand) expanded.add(id);
  else expanded.delete(id);

  if (m.expand) {
    const toInsert = flattenForInsert(id);
    // mutate visible and index map
    if (toInsert.length > 0) {
      visible.splice(idx + 1, 0, ...toInsert);
      // rebuild indices in affected range only (cheap enough for now)
      for (let i = idx + 1; i < visible.length; i++) idToIndex.set(visible[i] as NodeId, i);
    }
    const ms = performance.now() - start;
    return {
      type: 'PATCH',
      ops: [{ at: idx + 1, del: 0, ins: toInsert }],
      workerMs: ms,
      inserted: toInsert.length,
      deleted: 0,
    };
  }
  // collapse path
  const del = collapseCountAfter(idx, id);
  if (del > 0) {
    visible.splice(idx + 1, del);
    for (let i = idx + 1; i < visible.length; i++) idToIndex.set(visible[i] as NodeId, i);
  }
  const ms = performance.now() - start;
  return {
    type: 'PATCH',
    ops: [{ at: idx + 1, del, ins: [] }],
    workerMs: ms,
    inserted: 0,
    deleted: del,
  };
}

function handleFilterCommit(_m: FilterCommitMessage): ReplaceReply {
  const start = performance.now();
  // For B-phase: rebuild visible purely from current roots + expanded set (no filtering logic here)
  buildInitialVisible();
  return { type: 'REPLACE', ids: visible.slice(), workerMs: performance.now() - start };
}

function handlePrewarm(m: PrewarmMessage): void {
  // Precompute subtree flatten (based on current expansion set) and cache
  const list = flattenForInsert(m.id);
  lruSet(m.id, list);
}

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  try {
    const msg = e.data;
    switch (msg.type) {
      case 'INIT':
        handleInit(msg);
        ctx.postMessage({ type: 'ACK' } as AckReply);
        break;
      case 'EXPAND_TOGGLE': {
        const reply = handleToggle(msg);
        ctx.postMessage(reply as PatchReply);
        break;
      }
      case 'FILTER_COMMIT': {
        const reply = handleFilterCommit(msg);
        ctx.postMessage(reply as ReplaceReply);
        break;
      }
      case 'PREWARM_SUBTREE':
        handlePrewarm(msg);
        ctx.postMessage({ type: 'ACK' } as AckReply);
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    ctx.postMessage({ type: 'ERROR', message } as FromWorker);
  }
};
