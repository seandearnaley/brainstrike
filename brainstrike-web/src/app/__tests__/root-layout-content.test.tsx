import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import Sidebar from "../../components/custom/sidebar/sidebar";
import { Toaster } from "../../components/ui/toaster";
import { ThemeProvider } from "../../providers/theme-provider";
import RootLayoutContent from "../root-layout-content";

// Mock the dependencies
vi.mock("react-router-dom", () => ({
	Outlet: () => <div data-testid="outlet-mock">Outlet Mock</div>,
}));

vi.mock("../../components/custom/sidebar/sidebar", () => ({
	__esModule: true,
	default: vi.fn(() => <div data-testid="sidebar-mock">Sidebar Mock</div>),
}));

vi.mock("../../components/ui/toaster", () => ({
	Toaster: vi.fn(() => <div data-testid="toaster-mock">Toaster Mock</div>),
}));

vi.mock("../../providers/theme-provider", () => ({
	ThemeProvider: vi.fn(({ children, ...props }) => (
		<div data-testid="theme-provider-mock" data-props={JSON.stringify(props)}>
			{children}
		</div>
	)),
}));

describe("RootLayoutContent", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test("renders root layout with all required components", () => {
		render(<RootLayoutContent />);

		// Check if ThemeProvider is rendered with correct props via data attribute
		const themeProviderElement = screen.getByTestId("theme-provider-mock");
		const themeProps = JSON.parse(
			themeProviderElement.getAttribute("data-props") || "{}",
		);
		expect(themeProps.defaultTheme).toBe("system");
		expect(themeProps.storageKey).toBe("app-theme");

		// Check if Sidebar is rendered
		expect(Sidebar).toHaveBeenCalled();
		expect(screen.getByTestId("sidebar-mock")).toBeInTheDocument();

		// Check if Outlet is rendered for child routes
		expect(screen.getByTestId("outlet-mock")).toBeInTheDocument();

		// Check if Toaster is rendered
		expect(Toaster).toHaveBeenCalled();
		expect(screen.getByTestId("toaster-mock")).toBeInTheDocument();
	});

	test("has correct layout structure", () => {
		render(<RootLayoutContent />);

		// Check for main element with appropriate classes
		const mainElement = screen.getByRole("main");
		expect(mainElement).toHaveClass("flex-1");
		expect(mainElement).toHaveClass("overflow-auto");
		expect(mainElement).toHaveClass("p-4");

		// Check for the flex container
		expect(mainElement.parentElement).toHaveClass("flex");
		expect(mainElement.parentElement).toHaveClass("h-screen");
	});
});
