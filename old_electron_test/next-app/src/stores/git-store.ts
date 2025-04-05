import { copyDirectoryToLightningFS } from '@/lib/git-utils';
import { FSInitializationError, GitOperationError } from '@/types/errors';
import LightningFS from '@isomorphic-git/lightning-fs';
import * as git from 'isomorphic-git';
import { create } from 'zustand';

// Status enum to replace multiple loading states
type GitStatus =
  | 'idle'
  | 'initializing'
  | 'loading_history'
  | 'loading_branches'
  | 'comparing'
  | 'error';

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
  error: { code: string; message: string; retry?: () => Promise<void> } | null;
  lastInitializedRepoPath: string | null;
  activeTab: 'history' | 'compare' | 'recent' | 'hotspots';

  // Actions
  initializeFS: (dirHandle: FileSystemDirectoryHandle) => Promise<void>;
  clearState: () => void;
  loadBranchInfo: () => Promise<void>;
  loadCommitHistory: () => Promise<void>;
  compareBranches: () => Promise<void>;
  setSelectedBranches: (base: string, compare: string) => void;
  setActiveTab: (tab: 'history' | 'compare' | 'recent' | 'hotspots') => void;
}

const initialState = {
  fs: null,
  path: null,
  isGitRepo: false,
  status: 'idle' as GitStatus,
  commits: [],
  currentBranch: null,
  branches: [],
  diffResultsByPair: {},
  selectedBaseBranch: '',
  selectedCompareBranch: '',
  error: null,
  lastInitializedRepoPath: null,
  activeTab: 'history' as 'history' | 'compare' | 'recent' | 'hotspots',
};

export const useGitStore = create<GitState>((set, get) => ({
  ...initialState,

  clearState: () => {
    set(initialState);
  },

  setActiveTab: (tab: 'history' | 'compare' | 'recent' | 'hotspots') => {
    set({ activeTab: tab });
  },

  setSelectedBranches: (base: string, compare: string) => {
    set({ selectedBaseBranch: base, selectedCompareBranch: compare });
  },

  initializeFS: async (dirHandle: FileSystemDirectoryHandle) => {
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

      set({
        fs,
        path: repoPath,
        isGitRepo: true,
        status: 'idle',
        error: null,
        lastInitializedRepoPath: repoPath,
        commits: [],
        diffResultsByPair: {},
        currentBranch: null,
        branches: [],
        selectedBaseBranch: '',
        selectedCompareBranch: '',
      });

      await get().loadBranchInfo();
    } catch (error) {
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
    if (!fs || !path) return;

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

      set({
        currentBranch: current || null,
        branches: branchList,
        selectedBaseBranch: branchList.includes('main') ? 'main' : branchList[0] || '',
        selectedCompareBranch: current || branchList[0] || '',
        error: null,
        status: 'idle',
      });
    } catch (error) {
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
    if (!fs || !path) return;
    if (commits.length > 0 && status !== 'loading_history') return;

    set({ status: 'loading_history' });
    try {
      const commitHistory = await git.log({
        fs,
        dir: path,
        depth: 10,
      });

      set({ commits: commitHistory, error: null, status: 'idle' });
    } catch (error) {
      set({
        status: 'error',
        error: {
          code:
            error instanceof GitOperationError ? error.code || 'HISTORY_ERROR' : 'HISTORY_ERROR',
          message: error instanceof Error ? error.message : 'Failed to load commit history',
          retry: () => get().loadCommitHistory(),
        },
      });
    }
  },

  compareBranches: async () => {
    const { fs, path, selectedBaseBranch, selectedCompareBranch, diffResultsByPair } = get();
    if (!fs || !path || !selectedBaseBranch || !selectedCompareBranch) return;

    const diffKey = `${selectedBaseBranch}...${selectedCompareBranch}`;
    if (diffResultsByPair[diffKey]) return;

    set({ status: 'comparing' });
    try {
      const [baseOid, compareOid] = await Promise.all([
        git.resolveRef({ fs, dir: path, ref: selectedBaseBranch }),
        git.resolveRef({ fs, dir: path, ref: selectedCompareBranch }),
      ]);

      const diffs: FileDiff[] = [];
      await git.walk({
        fs,
        dir: path,
        trees: [git.TREE({ ref: baseOid }), git.TREE({ ref: compareOid })],
        map: async (filepath, [base, compare]) => {
          if (filepath === '.') return;
          if ((await base?.type()) === 'tree' || (await compare?.type()) === 'tree') return;

          const baseOid = await base?.oid();
          const compareOid = await compare?.oid();

          if (baseOid !== compareOid) {
            const diff: FileDiff = {
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
    } catch (error) {
      set({
        status: 'error',
        error: {
          code:
            error instanceof GitOperationError ? error.code || 'COMPARE_ERROR' : 'COMPARE_ERROR',
          message: error instanceof Error ? error.message : 'Failed to compare branches',
          retry: () => get().compareBranches(),
        },
      });
    }
  },
}));
