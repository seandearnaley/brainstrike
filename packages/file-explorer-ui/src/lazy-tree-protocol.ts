// Minimal shared types for worker protocol + host utilities

export type NodeType = 'file' | 'directory';

export interface TreeNode {
  name: string;
  path: string;
  type: NodeType;
  children?: TreeNode[];
}

export interface VisibleRow {
  path: string;
  name: string;
  type: NodeType;
  depth: number;
}

/** A single splice to transform old visible rows into new visible rows. */
export interface VisibleSplice {
  index: number; // where to start
  deleteCount: number; // how many to remove
  items: VisibleRow[]; // what to insert
}

export interface WorkerMetrics {
  calcMs: number;
  visibleCount: number;
  spliceCount: number; // 0 for FULL, 1 for single-splice diff
}

/** Optional, simple filter support (leave empty to skip). */
export interface FilterSpec {
  include?: string[]; // substring match on name or path
  exclude?: string[];
  /** Alternative: allow only these paths (exact match). */
  allowList?: string[];
}

export type ReqType =
  | 'INIT_TREE'
  | 'REPLACE_TREE'
  | 'EXPAND' // payload: { path: string }
  | 'COLLAPSE' // payload: { path: string }
  | 'APPLY_FILTER' // payload: { filter: FilterSpec }
  | 'FULL_VISIBLE' // recompute full visible rows (no diff)
  | 'PING';

export type ResType =
  | 'ACK'
  | 'VISIBLE_FULL' // payload: { rows: VisibleRow[], metrics }
  | 'VISIBLE_SPLICES' // payload: { splices: VisibleSplice[], metrics }
  | 'PONG'
  | 'ERROR';

export interface InboundMessage<T = unknown> {
  reqId: number;
  type: ReqType;
  payload?: T;
}

export interface OutboundMessage<T = unknown> {
  reqId: number;
  type: ResType;
  payload?: T;
  error?: string;
}
