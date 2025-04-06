import { describe, expect, it } from "vitest";
import { stableHash } from "../hash";

describe("hash", () => {
	describe("stableHash", () => {
		it("generates consistent hashes for the same input", () => {
			const input = "test/path/to/directory";
			expect(stableHash(input)).toBe(stableHash(input));
		});

		it("generates different hashes for different inputs", () => {
			const input1 = "test/path/to/directory1";
			const input2 = "test/path/to/directory2";
			expect(stableHash(input1)).not.toBe(stableHash(input2));
		});

		it('always starts with "h"', () => {
			const inputs = [
				"test",
				"very/long/path/to/somewhere",
				"!@#$special%^&*chars",
				"",
			];

			for (const input of inputs) {
				expect(stableHash(input)).toMatch(/^h[a-z0-9]+$/);
			}
		});

		it("handles empty strings", () => {
			expect(stableHash("")).toBe(stableHash(""));
		});

		it("handles special characters", () => {
			const input = "!@#$%^&*()_+-=[]{}|;:,.<>?";
			expect(stableHash(input)).toBe(stableHash(input));
		});

		it("generates reasonable length hashes", () => {
			const longInput = "a".repeat(1000);
			const hash = stableHash(longInput);
			expect(hash.length).toBeLessThan(20); // Should be much shorter than input
		});
	});
});
