import { vi } from "vitest";

// Define types directly since we're in a mock
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
	usePartial: boolean;
}

const initialState = {
	recentlyTouchedFiles: [] as RecentlyTouchedFile[],
	hotspotData: [] as HotspotData[],
	commitRangeConfig: {
		depth: 10,
		usePartial: true,
	} as CommitRangeConfig,
	isAnalyzing: false,
	error: null as string | null,
};

// Create a mock store with methods for setting state in tests
const mockGitAnalysisState = {
	...initialState,
	setCommitRangeConfig: vi.fn((_config: Partial<CommitRangeConfig>) => {}),
	analyzeAll: vi.fn(async () => {}),
	analyzeRecentFiles: vi.fn(async () => {}),
	analyzeHotspots: vi.fn(async () => {}),
	clearAnalysis: vi.fn(() => {}),
};

// Functions to update the mock state in tests
export const mockGitAnalysisStoreMethods = {
	setState: (newState: Partial<typeof initialState>) => {
		Object.assign(mockGitAnalysisState, newState);
	},
	reset: () => {
		Object.assign(mockGitAnalysisState, initialState);
		// Reset all the function mocks
		const functionMocks = Object.values(mockGitAnalysisState).filter(
			(value) => typeof value === "function",
		);

		for (const fn of functionMocks) {
			(fn as ReturnType<typeof vi.fn>).mockClear();
		}
	},
};

// Mock implementation of the hook
export const useGitAnalysisStore = vi.fn(
	(selector = (state: typeof mockGitAnalysisState) => state) =>
		selector(mockGitAnalysisState),
);

// Export the mock state for direct access in tests
export { mockGitAnalysisState };

export default useGitAnalysisStore;
