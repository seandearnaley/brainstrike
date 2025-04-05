export interface FileDiff {
    path: string;
    type: 'add' | 'modify' | 'remove';
    oldContent?: string;
    newContent?: string;
}
export interface GitCommit {
    oid: string;
    commit: {
        message: string;
        author: {
            name: string;
            email: string;
            timestamp: number;
        };
    };
}
export type GitError = {
    code: string;
    message: string;
    retry?: () => Promise<void>;
};
export type GitStatus = 'idle' | 'initializing' | 'loading_history' | 'loading_branches' | 'comparing' | 'error';
declare const initialState: {
    fs: null;
    path: null;
    isGitRepo: boolean;
    status: GitStatus;
    commits: GitCommit[];
    currentBranch: null;
    branches: string[];
    diffResultsByPair: Record<string, FileDiff[]>;
    selectedBaseBranch: string;
    selectedCompareBranch: string;
    error: GitError | null;
    lastInitializedRepoPath: null;
    activeTab: "history" | "compare" | "analysis";
};
declare const mockGitState: {
    clearState: import("vitest").Mock<() => void>;
    setActiveTab: import("vitest").Mock<(_tab: "history" | "compare" | "analysis") => void>;
    setSelectedBranches: import("vitest").Mock<(_base: string, _compare: string) => void>;
    initializeFS: import("vitest").Mock<(_dirHandle: FileSystemDirectoryHandle) => Promise<void>>;
    loadBranchInfo: import("vitest").Mock<() => Promise<void>>;
    loadCommitHistory: import("vitest").Mock<() => Promise<void>>;
    compareBranches: import("vitest").Mock<() => Promise<void>>;
    fs: null;
    path: null;
    isGitRepo: boolean;
    status: GitStatus;
    commits: GitCommit[];
    currentBranch: null;
    branches: string[];
    diffResultsByPair: Record<string, FileDiff[]>;
    selectedBaseBranch: string;
    selectedCompareBranch: string;
    error: GitError | null;
    lastInitializedRepoPath: null;
    activeTab: "history" | "compare" | "analysis";
};
export declare const mockGitStoreMethods: {
    setState: (newState: Partial<typeof initialState>) => void;
    reset: () => void;
};
export declare const useGitStore: import("vitest").Mock<(selector?: any) => any>;
export { mockGitState };
export default useGitStore;
//# sourceMappingURL=git-store.d.ts.map