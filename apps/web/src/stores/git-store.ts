import { FSInitializationError, GitOperationError } from '@brainstrike/types';
import LightningFS from '@isomorphic-git/lightning-fs';
import * as git from 'isomorphic-git';
import { create } from 'zustand';
import { copyDirectoryToLightningFS } from '../lib/git-utils';

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
  oldContent: string | undefined;
  newContent: string | undefined;
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
  activeTab: 'history' | 'compare' | 'analysis';

  // Actions
  initializeFS: (dirHandle: FileSystemDirectoryHandle) => Promise<void>;
  clearState: () => void;
  loadBranchInfo: () => Promise<void>;
  loadCommitHistory: () => Promise<void>;
  compareBranches: () => Promise<void>;
  setSelectedBranches: (base: string, compare: string) => void;
  setActiveTab: (tab: 'history' | 'compare' | 'analysis') => void;
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
  activeTab: 'history' as 'history' | 'compare' | 'analysis',
};

export const useGitStore = create<GitState>((set, get) => ({
  ...initialState,

  clearState: () => {
    set(initialState);
  },

  setActiveTab: (tab: 'history' | 'compare' | 'analysis') => {
    set({ activeTab: tab });
  },

  setSelectedBranches: (base: string, compare: string) => {
    set({ selectedBaseBranch: base, selectedCompareBranch: compare });
  },

  initializeFS: async (dirHandle: FileSystemDirectoryHandle) => {
    const repoPath = `/${dirHandle.name}`;
    const { lastInitializedRepoPath } = get();

    if (lastInitializedRepoPath === repoPath) {
      console.log(
        '[GitStore] Repository path matches last initialized, skipping re-initialization.'
      );
      set({ status: 'idle' }); // Ensure status is idle if we skip
      return;
    }

    console.log(`[GitStore] Initializing FS for repository: ${repoPath}`);
    set({ status: 'initializing', error: null, fs: null, path: null, isGitRepo: false }); // Reset state fully on new init

    // Create a unique FS instance for this repository
    const fs = new LightningFS(`git-fs-${dirHandle.name}`);

    try {
      // Check if .git exists first
      try {
        await dirHandle.getDirectoryHandle('.git', { create: false });
      } catch (e) {
        if (e instanceof Error && e.name === 'NotFoundError') {
          throw new FSInitializationError(
            'GIT_DIR_NOT_FOUND',
            'The selected directory does not appear to contain a .git folder.'
          );
        }
        throw e; // Re-throw other errors
      }

      console.log('[GitStore] Copying .git directory to LightningFS...');
      await copyDirectoryToLightningFS(dirHandle, fs, repoPath);

      // Short delay before diagnostic check
      await new Promise((resolve) => setTimeout(resolve, 200));

      console.log('[GitStore] Performing diagnostic check...');
      try {
        // Step 1: Check if .git/HEAD exists and read its content
        const headFilePath = `${repoPath}/.git/HEAD`;
        console.log(`[GitStore] Diagnostic Step 1: Reading ${headFilePath}`);
        // Correctly provide 'utf8' encoding as the second argument
        const headFileContent = await fs.promises.readFile(headFilePath, 'utf8');
        // Add type check before using .trim() due to typing ambiguity
        const headContentTrimmed =
          typeof headFileContent === 'string'
            ? headFileContent.trim()
            : '[Non-string HEAD content]';
        console.log(
          `[GitStore] Diagnostic Step 1 SUCCESS: Read ${headFilePath}, content: ${headContentTrimmed}`
        );

        // Step 1.5: Check if the file referenced by HEAD exists
        let refPath: string | null = null;
        if (typeof headFileContent === 'string' && headFileContent.startsWith('ref: ')) {
          refPath = headFileContent.substring(5).trim(); // Get the path like 'refs/heads/main'
          const fullRefPath = `${repoPath}/.git/${refPath}`;
          console.log(
            `[GitStore] Diagnostic Step 1.5: Checking existence of resolved HEAD ref file: ${fullRefPath}`
          );
          try {
            await fs.promises.stat(fullRefPath);
            console.log(`[GitStore] Diagnostic Step 1.5 SUCCESS: File ${fullRefPath} exists.`);
          } catch (statError) {
            console.error(
              `[GitStore] Diagnostic Step 1.5 FAILED: File ${fullRefPath} not found in FS!`,
              statError
            );
            // Optional: Throw here if this check failing guarantees resolveRef will fail?
            // throw new Error(`Referenced HEAD file ${fullRefPath} not found after copy.`);
          }
        } else {
          console.log(
            '[GitStore] Diagnostic Step 1.5 SKIPPED: HEAD content is not a symbolic ref or not a string.'
          );
        }

        // Step 2: Attempt to resolve the HEAD reference using isomorphic-git
        console.log(
          '[GitStore] Diagnostic Step 2: Resolving HEAD reference (using isomorphic-git)...'
        );
        const headOid = await git.resolveRef({
          fs,
          dir: repoPath,
          ref: 'HEAD',
        });
        console.log(`[GitStore] Diagnostic Step 2 SUCCESS: HEAD resolved to ${headOid}`);

        // If both diagnostic steps are successful, update state
        set({
          fs,
          path: repoPath,
          isGitRepo: true,
          status: 'loading_branches', // Proceed to load branches
          error: null,
          lastInitializedRepoPath: repoPath, // Store the path of the successfully initialized repo
        });
        console.log('[GitStore] FS Initialization successful, proceeding to load branches.');
        // Trigger branch loading after successful initialization
        get().loadBranchInfo();
      } catch (error) {
        console.error('[GitStore] DIAGNOSTIC FAILED:', error);
        // If the specific error is NotFoundError, provide more context
        if (error instanceof git.Errors.NotFoundError) {
          console.error(
            `[GitStore] NotFoundError details: Could not find ref '${error.data?.what}' during diagnostic check.`
          );
        }
        // Throw a specific error if the diagnostic check fails
        throw new FSInitializationError(
          'DIAGNOSTIC_READ_FAILED',
          `Post-copy check failed: Unable to resolve HEAD. ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } catch (error) {
      console.error('[GitStore] Error during FS Initialization:', error);
      // Handle specific error types if needed, otherwise generic message
      let errorCode = 'INIT_ERROR';
      let errorMessage = 'Failed to initialize repository';
      if (error instanceof Error) {
        errorMessage = error.message;
        // Check for common FS errors
        if (error.name === 'NotFoundError') {
          errorCode = 'GIT_DIR_NOT_FOUND';
          errorMessage = 'The selected directory does not appear to contain a .git folder.';
        } else if (error instanceof FSInitializationError) {
          // Use the code from our custom error or timeout error
          errorCode = error.code || 'FS_INIT_ERROR';
          errorMessage = error.message; // Use the message from the custom error
        } else if (error instanceof git.Errors.NotFoundError) {
          errorCode = 'DIAGNOSTIC_READ_FAILED';
          errorMessage = `Failed to find ref '${error.data?.what}' during initialization`;
        }
      }

      set({
        fs: null, // Ensure fs is null on failure
        path: null,
        isGitRepo: false,
        status: 'error',
        error: { code: errorCode, message: errorMessage },
        lastInitializedRepoPath: null, // Clear last initialized path on error
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

      const validBranches = branchList.filter((b) => b); // Filter out potentially null/empty strings
      const baseBranch = validBranches.includes('main') ? 'main' : validBranches[0] || '';
      const compareBranch =
        current && validBranches.includes(current) ? current : validBranches[0] || '';

      set({
        currentBranch: current || null,
        branches: validBranches, // Store the filtered list
        selectedBaseBranch: baseBranch,
        selectedCompareBranch: compareBranch,
        error: null, // Assuming success if we reach here, might need refinement
        status: 'idle',
      });
    } catch (error) {
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
    if (!fs || !path) return;
    if (commits.length > 0 && status !== 'loading_history') return;

    set({ status: 'loading_history' });
    try {
      const commitHistory = await git.log({
        fs,
        dir: path,
      });

      set({ commits: commitHistory, error: null, status: 'idle' });
    } catch (error) {
      console.error('[GitStore] Error in loadCommitHistory:', error);
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
              oldContent: undefined,
              newContent: undefined,
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

              // Explicitly handle undefined
              diff.oldContent = baseContent !== undefined ? baseContent : undefined;
              diff.newContent = compareContent !== undefined ? compareContent : undefined;
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
      console.error('[GitStore] Error in compareBranches:', error);
      const { selectedBaseBranch, selectedCompareBranch } = get();
      console.error(
        `[GitStore] Failed comparing branches: ${selectedBaseBranch} vs ${selectedCompareBranch}`
      );
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
