import { describe, expect, it } from "vitest";
import { resetAllMocks, resetStore } from "../test-utils";

describe("test-utils", () => {
	it("resetAllMocks should be a function", () => {
		expect(typeof resetAllMocks).toBe("function");
		// We can't easily test that it calls vi.clearAllMocks as that's internal to vitest
		// Just verify it can be called without errors
		expect(() => resetAllMocks()).not.toThrow();
	});

	it("resetStore should be a function that does not throw errors", () => {
		expect(typeof resetStore).toBe("function");
		expect(() => resetStore()).not.toThrow();
	});
});
