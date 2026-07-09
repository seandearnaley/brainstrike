import type { TapestryRange } from './tapestry/types';

export interface ContextExportOptions {
  projectTreeUsesViewFilters: boolean;
  selectedLineRangesByFile: Record<string, TapestryRange[]>;
}
