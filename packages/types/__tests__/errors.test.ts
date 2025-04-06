import { PartialRefreshError } from "../errors";

describe("PartialRefreshError", () => {
	it("should create an error with the correct properties", () => {
		const error = new PartialRefreshError("Partial failure", 10, 5);

		expect(error).toBeInstanceOf(PartialRefreshError);
		expect(error.name).toBe("PartialRefreshError");
		expect(error.successCount).toBe(10);
		expect(error.failCount).toBe(5);
		expect(error.message).toBe("Partial failure");
	});

	it("should be catchable as a standard error", () => {
		const throwError = () => {
			throw new PartialRefreshError("Test error", 1, 1);
		};

		expect(throwError).toThrow(Error);
		expect(throwError).toThrow(PartialRefreshError);
		expect(throwError).toThrow("Test error");
	});

	it("should maintain instanceof behavior when caught", () => {
		try {
			throw new PartialRefreshError("Test error", 1, 1);
		} catch (error) {
			expect(error).toBeInstanceOf(PartialRefreshError);
			expect(error).toBeInstanceOf(Error);
		}
	});
});
