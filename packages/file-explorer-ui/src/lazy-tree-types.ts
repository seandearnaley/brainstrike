import type { FlatRow } from './types/lazy-tree';

export interface LazyTreeApi {
  getRange(start: number, end: number): Promise<FlatRow[]>;
  expand(paths: string[]): void;
  collapse(paths: string[]): void;
  resetExpansion(): void;
  readonly rows: FlatRow[];
  readonly expanded: ReadonlySet<string>;
}
