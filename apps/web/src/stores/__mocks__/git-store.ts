import { vi } from 'vitest';

// Define types directly in the mock to avoid import issues
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

export type GitStatus =
  | 'idle'
  | 'initializing'
  | 'loading_history'
  | 'loading_branches'
  | 'comparing'
  | 'error';

// Mock implementation of useGitStore for testing
const initialState = {
  fs: null,
  path: null,
  isGitRepo: false,
  status: 'idle' as GitStatus,
  commits: [] as GitCommit[],
  currentBranch: null,
  branches: [] as string[],
  diffResultsByPair: {} as Record<string, FileDiff[]>,
  selectedBaseBranch: '',
  selectedCompareBranch: '',
  error: null as GitError | null,
  lastInitializedRepoPath: null,
  activeTab: 'history' as 'history' | 'compare' | 'analysis',
};

// Create a mock store with methods for setting state in tests
const mockGitState = {
  ...initialState,
  clearState: vi.fn(() => {}),
  setActiveTab: vi.fn((_tab: 'history' | 'compare' | 'analysis') => {}),
  setSelectedBranches: vi.fn((_base: string, _compare: string) => {}),
  initializeFS: vi.fn(async (_dirHandle: FileSystemDirectoryHandle) => {}),
  loadBranchInfo: vi.fn(async () => {}),
  loadCommitHistory: vi.fn(async () => {}),
  compareBranches: vi.fn(async () => {}),
};

// Functions to update the mock state in tests
export const mockGitStoreMethods = {
  setState: (newState: Partial<typeof initialState>) => {
    Object.assign(mockGitState, newState);
  },
  reset: () => {
    Object.assign(mockGitState, initialState);
    // Reset all the function mocks
    const functionMocks = Object.values(mockGitState).filter(
      (value) => typeof value === 'function'
    );

    for (const fn of functionMocks) {
      (fn as ReturnType<typeof vi.fn>).mockClear();
    }
  },
};

// Mock implementation of the hook
export const useGitStore = vi.fn((selector = (state: typeof mockGitState) => state) =>
  selector(mockGitState)
);

// Export the mock state for direct access in tests
export { mockGitState };

export default useGitStore;
