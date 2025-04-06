import { act, renderHook } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUndoableAction } from "../use-undoable-action";

// Mock for toast functions
const mockDismiss = vi.fn();
const mockUpdate = vi.fn();

// Create a proper mock toast function that returns an object with id, dismiss, and update
const mockToastFn = vi.fn().mockImplementation(() => ({
	id: "mock-toast-id",
	dismiss: mockDismiss,
	update: mockUpdate,
}));

// Mock dependencies
vi.mock("@/components/ui/use-toast", () => ({
	useToast: () => ({
		toast: mockToastFn,
	}),
}));

// Mock the Button component
vi.mock("@/components/ui/button", () => ({
	Button: (props: { children: React.ReactNode; onClick?: () => void }) =>
		React.createElement(
			"button",
			{ type: "button", onClick: props.onClick },
			props.children,
		),
}));

describe("useUndoableAction", () => {
	// Setup mocks for setTimeout and clearTimeout
	const originalSetTimeout = global.setTimeout;
	const originalClearTimeout = global.clearTimeout;

	beforeEach(() => {
		vi.clearAllMocks();
		mockToastFn.mockClear();
		mockDismiss.mockClear();
		mockUpdate.mockClear();

		// Mock setTimeout to execute callback immediately and return a fake timer ID
		global.setTimeout = vi.fn((callback) => {
			if (typeof callback === "function") callback();
			return 123;
		}) as unknown as typeof global.setTimeout;

		// Mock clearTimeout
		global.clearTimeout = vi.fn();
	});

	afterEach(() => {
		// Restore original timers after tests
		global.setTimeout = originalSetTimeout;
		global.clearTimeout = originalClearTimeout;
	});

	const renderUseUndoableActionHook = () => {
		return renderHook(() => useUndoableAction<string, Set<string>>());
	};

	describe("Initialization", () => {
		it("should initialize with empty undoTimeouts", () => {
			const { result } = renderUseUndoableActionHook();
			expect(result.current.performUndoableAction).toBeDefined();
			expect(result.current.clearUndoTimeout).toBeDefined();
		});
	});

	describe("Action Handling", () => {
		it("should handle performUndoableAction correctly", async () => {
			const { result } = renderUseUndoableActionHook();
			const mockOnUndo = vi.fn();
			const mockSnapshot = new Set(["item1", "item2"]);

			await act(async () => {
				result.current.performUndoableAction("test-key", "test-item", {
					actionName: "Test Action",
					itemDescription: "Test Item",
					getStateSnapshot: () => mockSnapshot,
					onUndo: mockOnUndo,
				});
			});

			// Verify toast was called with correct parameters
			expect(mockToastFn).toHaveBeenCalledTimes(1);
			const toastCall = mockToastFn.mock.calls[0][0];
			expect(toastCall.title).toBe("Test Action");
			expect(toastCall.duration).toBe(5000); // Default duration
		});

		it("should clear timeout when unmounted", async () => {
			const { result, unmount } = renderUseUndoableActionHook();
			const mockOnUndo = vi.fn();

			await act(async () => {
				result.current.performUndoableAction("test-key", "test-item", {
					actionName: "Test Action",
					itemDescription: "Test Item",
					onUndo: mockOnUndo,
				});
			});

			// Unmount the component
			unmount();

			// Verify clearTimeout was called
			expect(global.clearTimeout).toHaveBeenCalledWith(123);
		});

		it("should handle undo action correctly", async () => {
			const { result } = renderUseUndoableActionHook();
			const mockOnUndo = vi.fn();
			const mockSnapshot = new Set(["item1", "item2"]);

			// Make sure mockToastFn returns a valid object with dismiss method
			mockToastFn.mockImplementationOnce(() => ({
				id: "mock-toast-id",
				dismiss: mockDismiss,
				update: mockUpdate,
			}));

			await act(async () => {
				result.current.performUndoableAction("test-key", "test-item", {
					actionName: "Test Action",
					itemDescription: "Test Item",
					getStateSnapshot: () => mockSnapshot,
					onUndo: mockOnUndo,
				});
			});

			// Get the onClick handler from the toast call
			const toastCall = mockToastFn.mock.calls[0][0];
			const undoButton = toastCall.description.props.children[1];

			// Simulate clicking the undo button
			await act(async () => {
				undoButton.props.onClick();
			});

			// Verify onUndo was called with correct parameters
			expect(mockOnUndo).toHaveBeenCalledWith("test-item", mockSnapshot);
			expect(mockDismiss).toHaveBeenCalled();
		});

		it("should clear existing timeout when performing new action with same key", async () => {
			const { result } = renderUseUndoableActionHook();
			const mockOnUndo = vi.fn();

			await act(async () => {
				result.current.performUndoableAction("test-key", "test-item-1", {
					actionName: "Test Action 1",
					itemDescription: "Test Item 1",
					onUndo: mockOnUndo,
				});
			});

			// Verify first toast was created
			expect(mockToastFn).toHaveBeenCalledTimes(1);

			// Perform a second action with the same key
			await act(async () => {
				result.current.performUndoableAction("test-key", "test-item-2", {
					actionName: "Test Action 2",
					itemDescription: "Test Item 2",
					onUndo: mockOnUndo,
				});
			});

			// Verify clearTimeout was called for the first action
			expect(global.clearTimeout).toHaveBeenCalledWith(123);

			// Verify second toast was created
			expect(mockToastFn).toHaveBeenCalledTimes(2);
		});

		it("should auto-dismiss after duration", async () => {
			const { result } = renderUseUndoableActionHook();
			const mockOnUndo = vi.fn();
			const customDuration = 3000;

			await act(async () => {
				result.current.performUndoableAction("test-key", "test-item", {
					actionName: "Test Action",
					itemDescription: "Test Item",
					duration: customDuration,
					onUndo: mockOnUndo,
				});
			});

			// Verify toast was called with custom duration
			const toastCall = mockToastFn.mock.calls[0][0];
			expect(toastCall.duration).toBe(customDuration);

			// Since we mocked setTimeout to execute immediately,
			// the timeout should have been cleared already
			expect(global.clearTimeout).not.toHaveBeenCalled();
		});
	});
});
