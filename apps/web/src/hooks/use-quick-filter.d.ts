import type { IFileNode } from '../lib/file/types';
export declare function useQuickFilter(fileTree: IFileNode[]): {
    quickFilter: string;
    setQuickFilter: import("react").Dispatch<import("react").SetStateAction<string>>;
    filteredTree: IFileNode[];
    clearFilter: () => void;
};
//# sourceMappingURL=use-quick-filter.d.ts.map