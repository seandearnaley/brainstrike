import LightningFS from '@isomorphic-git/lightning-fs';
type GitStatus = 'idle' | 'initializing' | 'loading_history' | 'loading_branches' | 'comparing' | 'error';
interface GitCommit {
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
interface FileDiff {
    path: string;
    type: 'add' | 'modify' | 'remove';
    oldContent?: string;
    newContent?: string;
}
interface GitState {
    fs: LightningFS | null;
    path: string | null;
    isGitRepo: boolean;
    status: GitStatus;
    commits: GitCommit[];
    currentBranch: string | null;
    branches: string[];
    diffResultsByPair: Record<string, FileDiff[]>;
    selectedBaseBranch: string;
    selectedCompareBranch: string;
    error: {
        code: string;
        message: string;
        retry?: () => Promise<void>;
    } | null;
    lastInitializedRepoPath: string | null;
    activeTab: 'history' | 'compare' | 'recent' | 'hotspots';
    initializeFS: (dirHandle: FileSystemDirectoryHandle) => Promise<void>;
    clearState: () => void;
    loadBranchInfo: () => Promise<void>;
    loadCommitHistory: () => Promise<void>;
    compareBranches: () => Promise<void>;
    setSelectedBranches: (base: string, compare: string) => void;
    setActiveTab: (tab: 'history' | 'compare' | 'recent' | 'hotspots') => void;
}
export declare const useGitStore: import("zustand").UseBoundStore<import("zustand").StoreApi<GitState>>;
export {};
//# sourceMappingURL=git-store.d.ts.map