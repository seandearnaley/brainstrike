import { vi } from 'vitest';
// Mock implementation of useGitStore for testing
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
// Create a mock store with methods for setting state in tests
const mockGitState = {
    ...initialState,
    clearState: vi.fn(() => { }),
    setActiveTab: vi.fn((_tab) => { }),
    setSelectedBranches: vi.fn((_base, _compare) => { }),
    initializeFS: vi.fn(async (_dirHandle) => { }),
    loadBranchInfo: vi.fn(async () => { }),
    loadCommitHistory: vi.fn(async () => { }),
    compareBranches: vi.fn(async () => { }),
};
// Functions to update the mock state in tests
export const mockGitStoreMethods = {
    setState: (newState) => {
        Object.assign(mockGitState, newState);
    },
    reset: () => {
        Object.assign(mockGitState, initialState);
        // Reset all the function mocks
        const functionMocks = Object.values(mockGitState).filter((value) => typeof value === 'function');
        for (const fn of functionMocks) {
            fn.mockClear();
        }
    },
};
// Mock implementation of the hook
export const useGitStore = vi.fn((selector = (state) => state) => selector(mockGitState));
// Export the mock state for direct access in tests
export { mockGitState };
export default useGitStore;
