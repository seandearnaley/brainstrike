import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_EXCLUDE_FILTERS,
	DEFAULT_INCLUDE_FILTERS,
} from "../../constants/file-explorer";
// Import the mock directly now, assuming it exports the hook
import { useFileExplorerStore } from "../../stores/__mocks__/use-file-explorer-store";
import {
	createDirectoryNode,
	createFileNode,
} from "../../test/factories/file-node";
import { useFileContentLoading } from "../use-file-content-loading";
import { useFileExplorer } from "../use-file-explorer";
import { useFileFilters } from "../use-file-filters";
import { useFileSystem } from "../use-file-system";
import { useFileTree } from "../use-file-tree";

// Mock dependencies
vi.mock("../use-file-system");
vi.mock("../use-file-tree");
vi.mock("../use-file-filters");
vi.mock("../use-file-content-loading");

// Mock the store using the mock implementation
// The mock file now exports the hook directly
vi.mock("@/stores/use-file-explorer-store", () => {
	return {
		useFileExplorerStore,
	};
});

// Define mocks at the describe scope to be accessible in all tests
const mockSelectRoot = vi.fn();
const mockApplyFileFilters = vi.fn();
const mockHandleFileContentLoading = vi.fn();

const mockFileNode = createFileNode({
	name: "test.txt",
	path: "/test.txt",
});

const mockDirectoryNode = createDirectoryNode({
	name: "testDir",
	path: "/testDir",
	children: [mockFileNode],
});

const defaultProps = {
	onDisplayedFilePathsChange: vi.fn(),
};

beforeEach(() => {
	vi.clearAllMocks();

	// Reset the mock store state if necessary (or rely on mock setup)
	// useFileExplorerStore.setState(useFileExplorerStore.getInitialState(), true);

	// Set up default mock return values
	mockApplyFileFilters.mockReturnValue([]);

	(useFileSystem as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
		rootDirectoryHandle: null,
		selectRootDirectory: mockSelectRoot,
		isFileSystemAccessSupported: () => ({ supported: true, reason: "" }),
		isAccessLoading: false,
	});

	(useFileTree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
		fileTree: [mockFileNode],
		isLoading: false,
		error: null,
		refreshTree: vi.fn(),
		loadingProgress: null,
	});

	(useFileFilters as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
		applyFileFilters: mockApplyFileFilters,
		filterError: null,
	});

	(
		useFileContentLoading as unknown as ReturnType<typeof vi.fn>
	).mockReturnValue({
		fileContents: {},
		isLoading: false,
		error: null,
		handleFileContentLoading: mockHandleFileContentLoading,
	});
});

const renderUseFileExplorerHook = (props = {}) => {
	return renderHook(() => useFileExplorer({ ...defaultProps, ...props }));
};

describe("Initialization", () => {
	beforeEach(() => {
		mockApplyFileFilters.mockReturnValue([]);
		(useFileTree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
			fileTree: [],
			isLoading: false,
			error: null,
			refreshTree: vi.fn(),
			loadingProgress: null,
		});
	});

	it("should initialize with empty file tree", () => {
		const { result } = renderUseFileExplorerHook();

		expect(result.current.fileTree).toEqual([]);
		expect(result.current.error).toBeNull();
		expect(result.current.isLoading).toBeFalsy();
	});

	it("should apply default filters when no filters are provided", () => {
		// Override with non-empty tree for this test
		const mockTree = [mockFileNode];
		const mockFilteredTree = [mockFileNode];
		mockApplyFileFilters.mockReturnValue(mockFilteredTree);

		(useFileTree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
			fileTree: mockTree,
			isLoading: false,
			error: null,
			refreshTree: vi.fn(),
			loadingProgress: null,
		});

		const { result } = renderUseFileExplorerHook();

		// Access store state via the hook result if needed for assertions
		const storeData = useFileExplorerStore.getState(); // Access the mocked store

		expect(mockApplyFileFilters).toHaveBeenCalledWith(
			mockTree,
			storeData.includeFilters, // Use state from mock store
			storeData.excludeFilters, // Use state from mock store
			storeData.useRegex, // Use state from mock store
		);
		expect(result.current.fileTree).toEqual(mockFilteredTree);
	});
});

describe("Directory Operations", () => {
	it("should handle root directory selection", async () => {
		const mockHandle = { kind: "directory" };
		mockSelectRoot.mockResolvedValue(mockHandle);
		const mockFilteredTree = [mockFileNode];
		mockApplyFileFilters.mockReturnValue(mockFilteredTree);

		const { result } = renderUseFileExplorerHook();

		await act(async () => {
			const handle = await result.current.handleRootDirectorySelect();
			expect(handle).toBe(mockHandle);
		});
	});
});

describe("File Content Loading", () => {
	beforeEach(() => {
		const mockFilteredTree = [mockFileNode];
		mockApplyFileFilters.mockReturnValue(mockFilteredTree);

		(useFileTree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
			fileTree: [mockFileNode],
			isLoading: false,
			error: null,
			refreshTree: vi.fn(),
			loadingProgress: null,
		});
	});

	it("should load file content", async () => {
		const mockContent = "test content";
		mockHandleFileContentLoading.mockResolvedValue(mockContent);

		(
			useFileContentLoading as unknown as ReturnType<typeof vi.fn>
		).mockReturnValue({
			fileContents: { "/test.txt": mockContent },
			isLoading: false,
			error: null,
			handleFileContentLoading: mockHandleFileContentLoading,
		});

		const { result } = renderUseFileExplorerHook();

		await act(async () => {
			await result.current.loadFileContent("/test.txt");
		});

		expect(mockHandleFileContentLoading).toHaveBeenCalledWith(["/test.txt"]);
	});
});

describe("Filter Operations", () => {
	it("should apply filters correctly", () => {
		const testTree = [mockFileNode, mockDirectoryNode];
		mockApplyFileFilters.mockReturnValue(testTree);

		const { result } = renderUseFileExplorerHook();

		const filteredTree = result.current.applyFileFilters(
			["*.txt"],
			[".git"],
			true,
		);

		expect(filteredTree).toEqual(testTree);
		expect(mockApplyFileFilters).toHaveBeenCalledWith(
			expect.any(Array),
			["*.txt"],
			[".git"],
			true,
		);
	});
});

describe("Refresh Operations", () => {
	it("should refresh file tree", async () => {
		const mockRefreshTree = vi.fn();
		const mockRootHandle = {} as FileSystemDirectoryHandle;
		const mockFilteredTree = [mockFileNode];
		mockApplyFileFilters.mockReturnValue(mockFilteredTree);

		(useFileSystem as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
			rootDirectoryHandle: mockRootHandle,
			selectRootDirectory: mockSelectRoot,
			isFileSystemAccessSupported: () => ({ supported: true, reason: "" }),
			isAccessLoading: false,
		});

		(useFileTree as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
			fileTree: [],
			isLoading: false,
			error: null,
			refreshTree: mockRefreshTree,
			loadingProgress: null,
		});

		const { result } = renderUseFileExplorerHook();

		await act(async () => {
			await result.current.refreshFileExplorer();
		});

		expect(mockRefreshTree).toHaveBeenCalled();
	});
});
