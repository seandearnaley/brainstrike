import type { TapestryRange } from './tapestry/types';

export interface ContextExportOptions {
  selectedLineRangesByFile: Record<string, TapestryRange[]>;
  useTapestryRanges: boolean;
  projectTreeUsesViewFilters: boolean;
}
