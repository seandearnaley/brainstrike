export type GitStatus = 'idle' | 'initializing' | 'loading_history' | 'loading_branches' | 'comparing' | 'error';
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
export interface FileDiff {
    path: string;
    type: 'add' | 'modify' | 'remove';
    oldContent?: string;
    newContent?: string;
}
export interface GitError {
    code: string;
    message: string;
    retry?: () => Promise<void>;
}
//# sourceMappingURL=git-types.d.ts.map