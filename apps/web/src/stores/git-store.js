import LightningFS from '@isomorphic-git/lightning-fs';
import * as git from 'isomorphic-git';
import { create } from 'zustand';
import { copyDirectoryToLightningFS } from '../lib/git-utils';
import { FSInitializationError, GitOperationError } from '../types/errors';
const initialState = {
    fs: null,
    path: null,
    isGitRepo: false,
    status: 'idle',
    commits: [],
    currentBranch: null,
    branches: [],
    diffResultsByPair: {},
    selectedBaseBranch: '',
    selectedCompareBranch: '',
    error: null,
    lastInitializedRepoPath: null,
    activeTab: 'history',
};
export const useGitStore = create((set, get) => ({
    ...initialState,
    clearState: () => {
        set(initialState);
    },
    setActiveTab: (tab) => {
        set({ activeTab: tab });
    },
    setSelectedBranches: (base, compare) => {
        set({ selectedBaseBranch: base, selectedCompareBranch: compare });
    },
    initializeFS: async (dirHandle) => {
        const repoPath = `/${dirHandle.name}`;
        const { lastInitializedRepoPath } = get();
        if (lastInitializedRepoPath === repoPath) {
            set({ status: 'idle' });
            return;
        }
        set({ status: 'initializing' });
        try {
            await dirHandle.getDirectoryHandle('.git', { create: false });
            const fs = new LightningFS('git-fs');
            await copyDirectoryToLightningFS(dirHandle, fs, repoPath);
            const problematicOID = '635fa4aa0aa95634a0dbc718be5a8d9a2d3e747d';
            let diagnosticReadOk = false;
            try {
                console.log(`[GitStore] Attempting to read problematic object ${problematicOID} directly after copy...`);
                const objectData = await git.readObject({ fs, dir: repoPath, oid: problematicOID });
                console.log(`[GitStore] Successfully read object ${problematicOID}. Type: ${objectData.type}, Size: ${objectData.object.toString().length}`);
                diagnosticReadOk = true; // Mark as successful
            }
            catch (readError) {
                console.error(`[GitStore] DIAGNOSTIC FAILED: Failed to read object ${problematicOID} directly after copy. Repo data likely incomplete/corrupted in LightningFS.`, readError);
                // Set a specific error state indicating potential corruption
                set({
                    fs, // Keep FS reference for potential retries/debugging
                    path: repoPath,
                    isGitRepo: true, // It *looks* like a git repo, but is unusable
                    status: 'error',
                    error: {
                        code: 'LFS_CORRUPTION_SUSPECTED',
                        message: `Failed initial consistency check after copying repository data. Object ${problematicOID.substring(0, 7)}... could not be read. The repository view may be incomplete or corrupted.`,
                        // No retry action here as it likely requires user intervention (e.g., trying a different repo)
                    },
                    lastInitializedRepoPath: repoPath,
                });
                // DO NOT proceed further if diagnostic fails
                return;
            }
            // Proceed only if diagnostic read was OK
            if (diagnosticReadOk) {
                set({
                    fs,
                    path: repoPath,
                    isGitRepo: true,
                    status: 'idle',
                    error: null,
                    lastInitializedRepoPath: repoPath,
                    // Reset other state parts
                    commits: [],
                    diffResultsByPair: {},
                    currentBranch: null,
                    branches: [],
                    selectedBaseBranch: '',
                    selectedCompareBranch: '',
                });
                // Now load branch info etc.
                await get().loadBranchInfo();
            }
        }
        catch (error) {
            // This catch handles errors from getDirectoryHandle or copyDirectoryToLightningFS (if it re-throws)
            console.error('[GitStore] Error during main initializeFS try block:', error);
            set({
                isGitRepo: false,
                status: 'error',
                error: {
                    code: error instanceof FSInitializationError ? error.code || 'INIT_ERROR' : 'INIT_ERROR',
                    message: error instanceof Error ? error.message : 'Failed to initialize repository',
                },
            });
        }
    },
    loadBranchInfo: async () => {
        const { fs, path } = get();
        if (!fs || !path)
            return;
        set({ status: 'loading_branches' });
        try {
            const [current, branchList] = await Promise.all([
                git.currentBranch({
                    fs,
                    dir: path,
                    fullname: false,
                }),
                git.listBranches({
                    fs,
                    dir: path,
                }),
            ]);
            const validBranches = branchList.filter((b) => b); // Filter out potentially null/empty strings
            const baseBranch = validBranches.includes('main') ? 'main' : validBranches[0] || '';
            const compareBranch = current && validBranches.includes(current) ? current : validBranches[0] || '';
            set({
                currentBranch: current || null,
                branches: validBranches, // Store the filtered list
                selectedBaseBranch: baseBranch,
                selectedCompareBranch: compareBranch,
                error: null, // Assuming success if we reach here, might need refinement
                status: 'idle',
            });
        }
        catch (error) {
            console.error('[GitStore] Error in loadBranchInfo:', error);
            set({
                status: 'error',
                error: {
                    code: error instanceof GitOperationError ? error.code || 'BRANCH_ERROR' : 'BRANCH_ERROR',
                    message: error instanceof Error ? error.message : 'Failed to load branch info',
                    retry: () => get().loadBranchInfo(),
                },
            });
        }
    },
    loadCommitHistory: async () => {
        const { fs, path, commits, status } = get();
        if (!fs || !path)
            return;
        if (commits.length > 0 && status !== 'loading_history')
            return;
        set({ status: 'loading_history' });
        try {
            const commitHistory = await git.log({
                fs,
                dir: path,
            });
            set({ commits: commitHistory, error: null, status: 'idle' });
        }
        catch (error) {
            console.error('[GitStore] Error in loadCommitHistory:', error);
            set({
                status: 'error',
                error: {
                    code: error instanceof GitOperationError ? error.code || 'HISTORY_ERROR' : 'HISTORY_ERROR',
                    message: error instanceof Error ? error.message : 'Failed to load commit history',
                    retry: () => get().loadCommitHistory(),
                },
            });
        }
    },
    compareBranches: async () => {
        const { fs, path, selectedBaseBranch, selectedCompareBranch, diffResultsByPair } = get();
        if (!fs || !path || !selectedBaseBranch || !selectedCompareBranch)
            return;
        const diffKey = `${selectedBaseBranch}...${selectedCompareBranch}`;
        if (diffResultsByPair[diffKey])
            return;
        set({ status: 'comparing' });
        try {
            const [baseOid, compareOid] = await Promise.all([
                git.resolveRef({ fs, dir: path, ref: selectedBaseBranch }),
                git.resolveRef({ fs, dir: path, ref: selectedCompareBranch }),
            ]);
            const diffs = [];
            await git.walk({
                fs,
                dir: path,
                trees: [git.TREE({ ref: baseOid }), git.TREE({ ref: compareOid })],
                map: async (filepath, [base, compare]) => {
                    if (filepath === '.')
                        return;
                    if ((await base?.type()) === 'tree' || (await compare?.type()) === 'tree')
                        return;
                    const baseOid = await base?.oid();
                    const compareOid = await compare?.oid();
                    if (baseOid !== compareOid) {
                        const diff = {
                            path: filepath,
                            type: !baseOid ? 'add' : !compareOid ? 'remove' : 'modify',
                        };
                        if (diff.type === 'modify') {
                            const [baseContent, compareContent] = await Promise.all([
                                baseOid
                                    ? git.readBlob({ fs, dir: path, oid: baseOid }).then(({ blob }) => {
                                        return new TextDecoder().decode(blob);
                                    })
                                    : Promise.resolve(undefined),
                                compareOid
                                    ? git.readBlob({ fs, dir: path, oid: compareOid }).then(({ blob }) => {
                                        return new TextDecoder().decode(blob);
                                    })
                                    : Promise.resolve(undefined),
                            ]);
                            diff.oldContent = baseContent;
                            diff.newContent = compareContent;
                        }
                        diffs.push(diff);
                    }
                },
            });
            set({
                diffResultsByPair: {
                    ...diffResultsByPair,
                    [diffKey]: diffs,
                },
                error: null,
                status: 'idle',
            });
        }
        catch (error) {
            console.error('[GitStore] Error in compareBranches:', error);
            const { selectedBaseBranch, selectedCompareBranch } = get();
            console.error(`[GitStore] Failed comparing branches: ${selectedBaseBranch} vs ${selectedCompareBranch}`);
            set({
                status: 'error',
                error: {
                    code: error instanceof GitOperationError ? error.code || 'COMPARE_ERROR' : 'COMPARE_ERROR',
                    message: error instanceof Error ? error.message : 'Failed to compare branches',
                    retry: () => get().compareBranches(),
                },
            });
        }
    },
}));
