import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import HomePageContent from "../home-page-content";

// Mock the ClientFileExplorer component
vi.mock("../../components/custom/client-file-explorer", () => ({
	__esModule: true,
	default: vi.fn(() => (
		<div data-testid="client-file-explorer">Mock ClientFileExplorer</div>
	)),
}));

describe("HomePageContent", () => {
	it("renders the ClientFileExplorer component", () => {
		const { getByTestId } = render(<HomePageContent />);

		// Check if the ClientFileExplorer is present
		expect(getByTestId("client-file-explorer")).toBeInTheDocument();
	});
});
