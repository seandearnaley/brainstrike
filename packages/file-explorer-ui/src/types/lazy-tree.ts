export type NodeKind = 'file' | 'directory';

export interface TreeNode {
  path: string;
  name: string;
  type: NodeKind;
  children?: TreeNode[];
  isVisible?: boolean;
}

export interface FlatRow {
  id: string;
  path: string;
  name: string;
  kind: NodeKind;
  depth: number;
  expanded?: boolean;
  hasChildren?: boolean;
  match?: boolean;
}

export interface Filters {
  include: string[];
  exclude: string[];
  useRegex: boolean;
  quick: string;
}

export type ToWorker =
  | { type: 'SET_SOURCE_TREE'; tree: TreeNode[] }
  | { type: 'SET_FILTERS'; filters: Filters }
  | { type: 'EXPAND'; paths: string[] }
  | { type: 'COLLAPSE'; paths: string[] }
  | { type: 'RESET_EXPANSION' }
  | { type: 'GET_RANGE'; start: number; end: number }
  | { type: 'REBUILD' };

export type FromWorker =
  | { type: 'ACK'; for: ToWorker['type'] }
  | { type: 'VISIBLE_LIST'; rows: FlatRow[]; totalCount: number }
  | { type: 'RANGE_DATA'; start: number; end: number; rows: FlatRow[] }
  | { type: 'STATS'; total: number; files: number; dirs: number; filteredOut: number }
  | { type: 'ERROR'; message: string; op?: ToWorker['type'] };
