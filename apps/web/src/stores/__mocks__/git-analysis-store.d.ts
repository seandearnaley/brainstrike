export interface RecentlyTouchedFile {
    path: string;
    lastCommitTimestamp: number;
    changes: number;
}
export interface HotspotData {
    path: string;
    score: number;
    changes: number;
    lastModified: number;
    totalLinesChanged: number;
}
export interface CommitRangeConfig {
    depth: number;
    usePartial: boolean;
}
declare const initialState: {
    recentlyTouchedFiles: RecentlyTouchedFile[];
    hotspotData: HotspotData[];
    commitRangeConfig: CommitRangeConfig;
    isAnalyzing: boolean;
    error: string | null;
};
declare const mockGitAnalysisState: {
    setCommitRangeConfig: import("vitest").Mock<(_config: Partial<CommitRangeConfig>) => void>;
    analyzeAll: import("vitest").Mock<() => Promise<void>>;
    analyzeRecentFiles: import("vitest").Mock<() => Promise<void>>;
    analyzeHotspots: import("vitest").Mock<() => Promise<void>>;
    clearAnalysis: import("vitest").Mock<() => void>;
    recentlyTouchedFiles: RecentlyTouchedFile[];
    hotspotData: HotspotData[];
    commitRangeConfig: CommitRangeConfig;
    isAnalyzing: boolean;
    error: string | null;
};
export declare const mockGitAnalysisStoreMethods: {
    setState: (newState: Partial<typeof initialState>) => void;
    reset: () => void;
};
export declare const useGitAnalysisStore: import("vitest").Mock<(selector?: any) => any>;
export { mockGitAnalysisState };
export default useGitAnalysisStore;
//# sourceMappingURL=git-analysis-store.d.ts.map