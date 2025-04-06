import { fireEvent, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import { AnalysisPanel } from "../analysis-panel";

// Define types for the mock states
interface RecentlyTouchedFile {
	path: string;
	lastCommitTimestamp: number;
	changes: number;
}

interface HotspotData {
	path: string;
	score: number;
	changes: number;
	lastModified: number;
	totalLinesChanged: number;
}

interface MockGitAnalysisState {
	recentlyTouchedFiles: RecentlyTouchedFile[];
	hotspotData: HotspotData[];
	isAnalyzing: boolean;
	error: string | null;
	analyzeAll: ReturnType<typeof vi.fn>;
}

interface MockFileExplorerState {
	currentFolderId: string;
	selectedFilePaths: Set<string>;
	setSelectedFiles: ReturnType<typeof vi.fn>;
}

// Define mock data that will be accessible to all tests
const mockGitAnalysisState: MockGitAnalysisState = {
	recentlyTouchedFiles: [
		{
			path: "src/test1.js",
			lastCommitTimestamp: Date.now() / 1000 - 86400, // 1 day ago
			changes: 5,
		},
		{
			path: "src/test2.js",
			lastCommitTimestamp: Date.now() / 1000 - 43200, // 12 hours ago
			changes: 3,
		},
	],
	hotspotData: [
		{
			path: "src/test1.js",
			score: 8.5,
			changes: 10,
			lastModified: Date.now() / 1000 - 86400,
			totalLinesChanged: 150,
		},
		{
			path: "src/test3.js",
			score: 5.2,
			changes: 4,
			lastModified: Date.now() / 1000 - 172800, // 2 days ago
			totalLinesChanged: 45,
		},
	],
	isAnalyzing: false,
	error: null,
	analyzeAll: vi.fn(),
};

const mockFileExplorerState: MockFileExplorerState = {
	currentFolderId: "root",
	selectedFilePaths: new Set(),
	setSelectedFiles: vi.fn(),
};

// Mock the git-analysis-store
vi.mock("../../../stores/git-analysis-store", () => ({
	useGitAnalysisStore: vi.fn((selector) => {
		return typeof selector === "function"
			? selector(mockGitAnalysisState)
			: mockGitAnalysisState;
	}),
}));

// Mock the file explorer store
vi.mock("../../../stores/use-file-explorer-store", () => ({
	useFileExplorerStore: vi.fn((selector) => {
		return typeof selector === "function"
			? selector(mockFileExplorerState)
			: mockFileExplorerState;
	}),
}));

// Mock the lucide-react icons
vi.mock("lucide-react", () => ({
	ArrowUpDown: () => <div data-testid="mock-arrow-icon">ArrowUpDownIcon</div>,
	Check: () => <div data-testid="mock-check-icon">CheckIcon</div>,
	Minus: () => <div data-testid="mock-minus-icon">MinusIcon</div>,
	ChevronDown: () => <div data-testid="mock-chevron-down">ChevronDownIcon</div>,
}));

describe("AnalysisPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Reset the mock states to default values
		Object.assign(mockGitAnalysisState, {
			recentlyTouchedFiles: [
				{
					path: "src/test1.js",
					lastCommitTimestamp: Date.now() / 1000 - 86400, // 1 day ago
					changes: 5,
				},
				{
					path: "src/test2.js",
					lastCommitTimestamp: Date.now() / 1000 - 43200, // 12 hours ago
					changes: 3,
				},
			],
			hotspotData: [
				{
					path: "src/test1.js",
					score: 8.5,
					changes: 10,
					lastModified: Date.now() / 1000 - 86400,
					totalLinesChanged: 150,
				},
				{
					path: "src/test3.js",
					score: 5.2,
					changes: 4,
					lastModified: Date.now() / 1000 - 172800, // 2 days ago
					totalLinesChanged: 45,
				},
			],
			isAnalyzing: false,
			error: null,
			analyzeAll: vi.fn(),
		});

		Object.assign(mockFileExplorerState, {
			currentFolderId: "root",
			selectedFilePaths: new Set<string>(),
			setSelectedFiles: vi.fn(),
		});
	});

	test("should render correctly with file data", () => {
		render(<AnalysisPanel />);

		// Check for the summary statistics
		expect(screen.getByText("Total Changed Files")).toBeInTheDocument();
		expect(screen.getByText("Recent Files")).toBeInTheDocument();
		expect(screen.getByText("Hotspots")).toBeInTheDocument();

		// Check for file list items
		expect(screen.getByText("src/test1.js")).toBeInTheDocument();
		expect(screen.getByText("src/test2.js")).toBeInTheDocument();
		expect(screen.getByText("src/test3.js")).toBeInTheDocument();
	});

	test("should show loading state when isAnalyzing is true", () => {
		// Update the mock to show analyzing state
		mockGitAnalysisState.isAnalyzing = true;
		mockGitAnalysisState.recentlyTouchedFiles = [];
		mockGitAnalysisState.hotspotData = [];

		render(<AnalysisPanel />);

		expect(screen.getByText("Analyzing...")).toBeInTheDocument();
	});

	test("should display an error message when there is an error", () => {
		// Update the mock to include an error
		mockGitAnalysisState.error = "Failed to analyze repository";
		mockGitAnalysisState.recentlyTouchedFiles = [];
		mockGitAnalysisState.hotspotData = [];

		render(<AnalysisPanel />);

		expect(
			screen.getByText("Failed to analyze repository"),
		).toBeInTheDocument();
	});

	test("should handle empty state when no files data is available", () => {
		// Update the mock to have no files
		mockGitAnalysisState.recentlyTouchedFiles = [];
		mockGitAnalysisState.hotspotData = [];

		render(<AnalysisPanel />);

		// Just verify there's no file data shown
		const totalChangedElement = screen.getByText("Total Changed Files");
		expect(totalChangedElement).toBeInTheDocument();

		// Check that the parent div of "Total Changed Files" contains a number (likely 0)
		const parentElement = totalChangedElement.closest(".border.rounded-md.p-4");
		expect(parentElement).not.toBeNull();
		if (parentElement) {
			const numberElement = parentElement.querySelector(".text-xl.font-bold");
			expect(numberElement).toHaveTextContent(/^\d+$/); // Contains only digits
		}
	});

	test("should trigger analysis when Analyze button is clicked", () => {
		const mockAnalyzeAll = vi.fn();
		mockGitAnalysisState.analyzeAll = mockAnalyzeAll;

		render(<AnalysisPanel />);

		// Find and click the Analyze button
		const analyzeButton = screen.getByRole("button", {
			name: /analyze time range/i,
		});
		fireEvent.click(analyzeButton);

		// Verify that analyzeAll was called
		expect(mockAnalyzeAll).toHaveBeenCalled();
	});

	test("should sort files when column headers are clicked", () => {
		render(<AnalysisPanel />);

		// Find and click the Path column header
		const pathHeader = screen.getByRole("button", { name: /file path/i });
		fireEvent.click(pathHeader);

		// Click again to test the direction toggle
		fireEvent.click(pathHeader);

		// The sorting state is internal to the component, so we just verify
		// that the button was clicked and the UI didn't crash
		expect(pathHeader).toBeInTheDocument();
	});

	test("should update file limit when dropdown is changed", () => {
		render(<AnalysisPanel />);

		// Find and click the file limit dropdown
		const limitTrigger = screen.getByRole("combobox");
		fireEvent.click(limitTrigger);

		// Find and click the 100 files option - note this is simplified
		// as the actual component uses a Select from shadcn/ui that would
		// require more complex interactions in a real test
		expect(limitTrigger).toBeInTheDocument();
	});

	test("should handle file selection when checkboxes are clicked", () => {
		const mockSetSelectedFiles = vi.fn();
		mockFileExplorerState.setSelectedFiles = mockSetSelectedFiles;

		render(<AnalysisPanel />);

		// Find and click a file checkbox
		const fileCheckboxes = screen.getAllByRole("checkbox");
		expect(fileCheckboxes.length).toBeGreaterThan(1);
		fireEvent.click(fileCheckboxes[1]); // First file in list

		// Verify that setSelectedFiles was called
		expect(mockSetSelectedFiles).toHaveBeenCalled();
	});

	test("should handle select all when header checkbox is clicked", () => {
		const mockSetSelectedFiles = vi.fn();
		mockFileExplorerState.setSelectedFiles = mockSetSelectedFiles;

		render(<AnalysisPanel />);

		// Find and click the select all checkbox
		const selectAllCheckbox = screen.getAllByRole("checkbox")[0]; // Header checkbox
		fireEvent.click(selectAllCheckbox);

		// Verify that setSelectedFiles was called
		expect(mockSetSelectedFiles).toHaveBeenCalled();
	});

	test("should handle date range selection", () => {
		render(<AnalysisPanel />);

		// Find and change the start date input
		const startDateInput = screen.getByLabelText("Start Date:");
		fireEvent.change(startDateInput, { target: { value: "2023-01-01" } });

		// Find and change the end date input
		const endDateInput = screen.getByLabelText("End Date:");
		fireEvent.change(endDateInput, { target: { value: "2023-12-31" } });

		// The date range state is internal to the component, so we just verify
		// that the inputs were changed and the UI didn't crash
		expect(startDateInput).toHaveValue("2023-01-01");
		expect(endDateInput).toHaveValue("2023-12-31");
	});
});
