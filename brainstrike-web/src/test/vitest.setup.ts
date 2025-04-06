import "@testing-library/jest-dom";
import { configure } from "@testing-library/react";
import { beforeEach, expect, vi } from "vitest";
import { resetStore } from "./test-utils";

// Configure React 18 test environment
configure({
	testIdAttribute: "data-testid",
});

// Reset store before each test
beforeEach(() => {
	resetStore();
});

// Add custom matchers
expect.extend({
	toBeInTheDocument(received) {
		const pass = Boolean(received);
		if (pass) {
			return {
				message: () => `expected ${received} not to be in the document`,
				pass: true,
			};
		}

		return {
			message: () => `expected ${received} to be in the document`,
			pass: false,
		};
	},
});

// Mock window.matchMedia
Object.defineProperty(window, "matchMedia", {
	writable: true,
	value: vi.fn().mockImplementation((query) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	})),
});

// Mock IntersectionObserver
class MockIntersectionObserver {
	constructor(callback: IntersectionObserverCallback) {
		this.callback = callback;
	}

	private callback: IntersectionObserverCallback;

	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
	takeRecords = vi.fn().mockReturnValue([]);
}

Object.defineProperty(window, "IntersectionObserver", {
	writable: true,
	configurable: true,
	value: MockIntersectionObserver,
});

// Mock ResizeObserver
class MockResizeObserver {
	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
	}

	private callback: ResizeObserverCallback;

	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
}

Object.defineProperty(window, "ResizeObserver", {
	writable: true,
	configurable: true,
	value: MockResizeObserver,
});

// Mock TextDecoder/TextEncoder for isomorphic-git
// This addresses the type compatibility issue with TextDecoder
class MockTextDecoder {
	// We're intentionally not using these parameters but need them for the interface
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	decode(
		_input?: ArrayBuffer | ArrayBufferView | null,
		_options?: { stream?: boolean },
	): string {
		return "";
	}
}

class MockTextEncoder {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	encode(_input?: string): Uint8Array {
		return new Uint8Array();
	}
}

// Use type assertion to avoid type compatibility issues
global.TextDecoder = MockTextDecoder as unknown as typeof global.TextDecoder;
global.TextEncoder = MockTextEncoder as unknown as typeof global.TextEncoder;

// Configure console to handle test output better
const originalError = console.error;
console.error = (...args) => {
	// List of expected error messages to filter
	const expectedErrors = [
		"Not implemented: window.computedStyle",
		"The current testing environment is not configured to support act",
		"inside a test was not wrapped in act",
		"Error: Access denied", // File access errors in tests
		"Error processing fail", // Expected file processing errors
		"PartialRefreshError", // Expected partial refresh errors
		"Error loading file tree", // Expected file tree loading errors
		"Error getting file handle", // Expected file handle errors
		"Failed to load file", // Expected file loading errors
		"Failed to refresh file tree", // Expected file tree refresh errors
	];

	// Check if any of the arguments contain expected error messages
	if (
		args.some((arg) => {
			const str = arg?.toString() || "";
			return (
				expectedErrors.some((expected) => str.includes(expected)) ||
				arg?.stack?.includes("Not implemented: window.computedStyle")
			);
		})
	) {
		return;
	}

	// Ignore specific React errors in tests
	if (
		typeof args[0] === "string" &&
		(args[0].includes("Warning: ReactDOM.render is no longer supported") ||
			args[0].includes("Warning: React.createFactory()") ||
			args[0].includes("Warning: Using UNSAFE_") ||
			args[0].includes("Warning: findDOMNode"))
	) {
		return;
	}
	originalError(...args);
};
