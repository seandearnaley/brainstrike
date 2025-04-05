import { vi } from 'vitest';
const initialState = {
    recentlyTouchedFiles: [],
    hotspotData: [],
    commitRangeConfig: {
        depth: 10,
        usePartial: true,
    },
    isAnalyzing: false,
    error: null,
};
// Create a mock store with methods for setting state in tests
const mockGitAnalysisState = {
    ...initialState,
    setCommitRangeConfig: vi.fn((_config) => { }),
    analyzeAll: vi.fn(async () => { }),
    analyzeRecentFiles: vi.fn(async () => { }),
    analyzeHotspots: vi.fn(async () => { }),
    clearAnalysis: vi.fn(() => { }),
};
// Functions to update the mock state in tests
export const mockGitAnalysisStoreMethods = {
    setState: (newState) => {
        Object.assign(mockGitAnalysisState, newState);
    },
    reset: () => {
        Object.assign(mockGitAnalysisState, initialState);
        // Reset all the function mocks
        const functionMocks = Object.values(mockGitAnalysisState).filter((value) => typeof value === 'function');
        for (const fn of functionMocks) {
            fn.mockClear();
        }
    },
};
// Mock implementation of the hook
export const useGitAnalysisStore = vi.fn((selector = (state) => state) => selector(mockGitAnalysisState));
// Export the mock state for direct access in tests
export { mockGitAnalysisState };
export default useGitAnalysisStore;
