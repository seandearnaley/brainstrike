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
    startDate?: Date;
    endDate?: Date;
    usePartial: boolean;
}
export interface GitAnalysisState {
    recentlyTouchedFiles: RecentlyTouchedFile[];
    hotspotData: HotspotData[];
    commitRangeConfig: CommitRangeConfig;
    isAnalyzing: boolean;
    error: string | null;
    setCommitRangeConfig: (config: Partial<CommitRangeConfig>) => void;
    analyzeAll: () => Promise<void>;
    analyzeRecentFiles: () => Promise<void>;
    analyzeHotspots: () => Promise<void>;
    clearAnalysis: () => void;
}
export declare const useGitAnalysisStore: import("zustand").UseBoundStore<import("zustand").StoreApi<GitAnalysisState>>;
//# sourceMappingURL=git-analysis-store.d.ts.map