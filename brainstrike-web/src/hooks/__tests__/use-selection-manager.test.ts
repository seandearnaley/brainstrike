import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFileExplorerStore } from "../../stores/use-file-explorer-store";
import { useSelectionManager } from "../use-selection-manager";

// Define type for the mock
type FileExplorerStoreMock = typeof useFileExplorerStore;

// Mock the useFileExplorerStore
vi.mock("../../stores/use-file-explorer-store", () => ({
	useFileExplorerStore: vi.fn(),
}));

describe("useSelectionManager", () => {
	const mockSetSelectedFiles = vi.fn();
	const mockOnSelectionLimitExceeded = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();

		// Set up mock implementation of useFileExplorerStore
		(
			useFileExplorerStore as jest.MockedFunction<FileExplorerStoreMock>
		).mockReturnValue({
			selectedFilePaths: new Set(["file1", "file2"]),
			maxSelectionCount: 5,
			setSelectedFiles: mockSetSelectedFiles,
		});
	});

	it("returns the current selected file paths", () => {
		const { result } = renderHook(() =>
			useSelectionManager({
				onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
			}),
		);

		expect(result.current.selectedFilePaths).toEqual(
			new Set(["file1", "file2"]),
		);
	});

	it("checks if selection would exceed limit and returns true when it would", () => {
		const { result } = renderHook(() =>
			useSelectionManager({
				onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
			}),
		);

		// Current selection has 2 files, max is 5, adding 4 new ones would exceed
		const wouldExceed = result.current.wouldExceedSelectionLimit([
			"file3",
			"file4",
			"file5",
			"file6",
		]);

		expect(wouldExceed).toBe(true);
	});

	it("checks if selection would exceed limit and returns false when it would not", () => {
		const { result } = renderHook(() =>
			useSelectionManager({
				onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
			}),
		);

		// Current selection has 2 files, max is 5, adding 3 new ones would not exceed
		const wouldExceed = result.current.wouldExceedSelectionLimit([
			"file3",
			"file4",
			"file5",
		]);

		expect(wouldExceed).toBe(false);
	});

	it("excludes already selected files when checking limit", () => {
		const { result } = renderHook(() =>
			useSelectionManager({
				onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
			}),
		);

		// Current selection has 2 files ('file1', 'file2'), max is 5
		// The new selection contains already selected files, so only 3 new files are added
		const wouldExceed = result.current.wouldExceedSelectionLimit([
			"file1",
			"file2",
			"file3",
			"file4",
			"file5",
		]);

		expect(wouldExceed).toBe(false);
	});

	it("calls onSelectionLimitExceeded when new selection would exceed limit", () => {
		const { result } = renderHook(() =>
			useSelectionManager({
				onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
			}),
		);

		// Try to add too many files
		act(() => {
			result.current.handleSelectionChange(
				new Set(["file1", "file2", "file3", "file4", "file5", "file6"]),
			);
		});

		// Should have called the callback
		expect(mockOnSelectionLimitExceeded).toHaveBeenCalled();
		// Should not have updated the store
		expect(mockSetSelectedFiles).not.toHaveBeenCalled();
	});

	it("updates selection when new selection is within limit", () => {
		const { result } = renderHook(() =>
			useSelectionManager({
				onSelectionLimitExceeded: mockOnSelectionLimitExceeded,
			}),
		);

		const newSelection = new Set(["file1", "file2", "file3"]);

		// Update with a valid selection
		act(() => {
			result.current.handleSelectionChange(newSelection);
		});

		// Should not have called the limit exceeded callback
		expect(mockOnSelectionLimitExceeded).not.toHaveBeenCalled();
		// Should have updated the store
		expect(mockSetSelectedFiles).toHaveBeenCalledWith(newSelection);
	});
});
