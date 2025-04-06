import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Home from "../page";

// Mock the ClientFileExplorer component since we want to unit test the page in isolation
vi.mock("@/components/custom/client-file-explorer", () => ({
	default: () => <div data-testid="mock-file-explorer">Mock File Explorer</div>,
}));

describe("Home Page", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders the ClientFileExplorer component", () => {
		render(<Home />);
		expect(screen.getByTestId("mock-file-explorer")).toBeInTheDocument();
		expect(screen.getByText("Mock File Explorer")).toBeInTheDocument();
	});
});
