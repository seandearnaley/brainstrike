import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateReport } from "../../utils/report-generator";
import { useReportGeneration } from "../use-report-generation";

// Mock the report generator
vi.mock("../../utils/report-generator", () => ({
	generateReport: vi.fn(),
}));

describe("useReportGeneration", () => {
	const mockSelectedFiles = new Set<string>(["file1.ts", "file2.ts"]);
	const mockFileContents = { "file1.ts": "content1", "file2.ts": "content2" };
	const mockRootDirectoryHandle = {} as FileSystemDirectoryHandle;
	const mockIncludeFilters = ["*.ts"];
	const mockExcludeFilters = ["node_modules"];
	const mockUseRegex = false;
	const mockIncludeProjectTree = true;
	const mockFolderSummaryThreshold = 5;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should initialize with isGenerating set to false", () => {
		const { result } = renderHook(() =>
			useReportGeneration({
				selectedFiles: mockSelectedFiles,
				fileContents: mockFileContents,
				rootDirectoryHandle: mockRootDirectoryHandle,
				includeFilters: mockIncludeFilters,
				excludeFilters: mockExcludeFilters,
				useRegex: mockUseRegex,
				includeProjectTree: mockIncludeProjectTree,
				folderSummaryThreshold: mockFolderSummaryThreshold,
			}),
		);

		expect(result.current.isGenerating).toBe(false);
	});

	it("should call generateReport with correct parameters", async () => {
		const mockReport = "<report>Test Report</report>";
		(
			generateReport as unknown as ReturnType<typeof vi.fn>
		).mockResolvedValueOnce(mockReport);

		const { result } = renderHook(() =>
			useReportGeneration({
				selectedFiles: mockSelectedFiles,
				fileContents: mockFileContents,
				rootDirectoryHandle: mockRootDirectoryHandle,
				includeFilters: mockIncludeFilters,
				excludeFilters: mockExcludeFilters,
				useRegex: mockUseRegex,
				includeProjectTree: mockIncludeProjectTree,
				folderSummaryThreshold: mockFolderSummaryThreshold,
			}),
		);

		let reportResult: string | undefined;
		await act(async () => {
			reportResult = await result.current.generateReportWithContent();
		});

		expect(generateReport).toHaveBeenCalledWith(
			mockSelectedFiles,
			mockFileContents,
			mockRootDirectoryHandle,
			mockIncludeFilters,
			mockExcludeFilters,
			mockUseRegex,
			mockIncludeProjectTree,
			mockFolderSummaryThreshold,
		);

		expect(reportResult).toBe(mockReport);
		expect(result.current.isGenerating).toBe(false);
	});

	it("should set isGenerating to true while generating the report", async () => {
		// Use a mock implementation that allows us to control when the promise resolves
		// and check the state during execution
		let resolvePromise: ((value: string) => void) | undefined;

		// Create a promise that we can manually resolve
		const delayedPromise = new Promise<string>((resolve) => {
			resolvePromise = resolve;
		});

		// Mock implementation that allows us to check the state during execution
		(generateReport as unknown as ReturnType<typeof vi.fn>).mockImplementation(
			() => {
				// Return our controlled promise
				return delayedPromise;
			},
		);

		const { result } = renderHook(() =>
			useReportGeneration({
				selectedFiles: mockSelectedFiles,
				fileContents: mockFileContents,
				rootDirectoryHandle: mockRootDirectoryHandle,
				includeFilters: mockIncludeFilters,
				excludeFilters: mockExcludeFilters,
				useRegex: mockUseRegex,
				includeProjectTree: mockIncludeProjectTree,
				folderSummaryThreshold: mockFolderSummaryThreshold,
			}),
		);

		// Start the report generation process but don't await its completion
		let generatePromise: Promise<string | undefined>;

		await act(async () => {
			// Start the generation process
			generatePromise = result.current.generateReportWithContent();
		});

		// Check the state right after starting (should be generating)
		expect(result.current.isGenerating).toBe(true);

		// Now complete the operation
		await act(async () => {
			if (resolvePromise) {
				resolvePromise("test report");
			}
			// Wait for the generateReportWithContent promise to resolve
			await generatePromise;
		});

		// After completion, isGenerating should be false
		expect(result.current.isGenerating).toBe(false);
	});

	it("should throw an error if no root directory handle is provided", async () => {
		const { result } = renderHook(() =>
			useReportGeneration({
				selectedFiles: mockSelectedFiles,
				fileContents: mockFileContents,
				rootDirectoryHandle: undefined,
				includeFilters: mockIncludeFilters,
				excludeFilters: mockExcludeFilters,
				useRegex: mockUseRegex,
				includeProjectTree: mockIncludeProjectTree,
				folderSummaryThreshold: mockFolderSummaryThreshold,
			}),
		);

		await expect(result.current.generateReportWithContent()).rejects.toThrow(
			"No root directory selected",
		);
	});

	it("should set isGenerating to false even if report generation fails", async () => {
		(
			generateReport as unknown as ReturnType<typeof vi.fn>
		).mockRejectedValueOnce(new Error("Test error"));

		const { result } = renderHook(() =>
			useReportGeneration({
				selectedFiles: mockSelectedFiles,
				fileContents: mockFileContents,
				rootDirectoryHandle: mockRootDirectoryHandle,
				includeFilters: mockIncludeFilters,
				excludeFilters: mockExcludeFilters,
				useRegex: mockUseRegex,
				includeProjectTree: mockIncludeProjectTree,
				folderSummaryThreshold: mockFolderSummaryThreshold,
			}),
		);

		await act(async () => {
			try {
				await result.current.generateReportWithContent();
			} catch {
				// Expected error
			}
		});

		expect(result.current.isGenerating).toBe(false);
	});
});
