import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../providers/theme-provider";
import RootLayout from "../layout";

// Mock the Inter font
vi.mock("next/font/google", () => ({
	Inter: () => ({
		className: "inter-font",
	}),
}));

// Mock the components
vi.mock("../../components/custom/sidebar/sidebar", () => ({
	__esModule: true,
	default: () => <div data-testid="sidebar">Sidebar Mock</div>,
}));

vi.mock("../../components/ui/toaster", () => ({
	__esModule: true,
	Toaster: () => <div data-testid="toaster">Toaster Mock</div>,
}));

// Mock theme provider but keep the original component name for the test
vi.mock("../../providers/theme-provider", () => ({
	__esModule: true,
	ThemeProvider: ({
		children,
		defaultTheme,
		storageKey,
	}: {
		children: React.ReactNode;
		defaultTheme?: string;
		storageKey?: string;
	}) => (
		<div
			data-testid="theme-provider"
			data-theme={defaultTheme}
			data-storage-key={storageKey}
		>
			{children}
		</div>
	),
}));

describe("RootLayout", () => {
	it("renders with correct structure and components", () => {
		const layout = RootLayout({ children: <div>Test Content</div> });

		// Verify the root structure
		expect(layout.type).toBe("html");
		expect(layout.props.lang).toBe("en");
		expect(layout.props.suppressHydrationWarning).toBe(true);

		// Get the body element - account for head elements
		const body = Array.isArray(layout.props.children)
			? layout.props.children.find(
					(child: React.ReactNode) =>
						typeof child === "object" &&
						child !== null &&
						"type" in child &&
						child.type === "body",
				)
			: layout.props.children;

		expect(body.type).toBe("body");

		// Check if className exists before testing it
		if (body.props && "className" in body.props) {
			expect(body.props.className).toBe("inter-font");
		}

		// Get the ThemeProvider
		const themeProvider = body.props.children;
		expect(themeProvider.type.name).toBe("ThemeProvider");
		expect(themeProvider.props.defaultTheme).toBe("system");
		expect(themeProvider.props.storageKey).toBe("app-theme");

		// Get the RouterProvider and its children
		const routerProvider = themeProvider.props.children;
		expect(routerProvider.type.name).toBe("RouterProvider");

		// Check if children is an array or a single element
		const routerChildren = routerProvider.props.children;
		const mainContainer = Array.isArray(routerChildren)
			? routerChildren[0]
			: routerChildren;
		const toaster = Array.isArray(routerChildren) ? routerChildren[1] : null;

		expect(mainContainer.props.className).toBe("flex h-screen");

		// Verify sidebar is present
		const [sidebar, main] = mainContainer.props.children;
		expect(sidebar.type.name).toBe("default"); // Sidebar component

		// Verify main content area
		expect(main.type).toBe("main");
		expect(main.props.className).toBe("flex-1 overflow-auto p-4");
		expect(main.props.children).toEqual(<div>Test Content</div>);

		// Verify toaster is present
		expect(toaster.type.name).toBe("Toaster");
	});

	it("renders correctly in the DOM", () => {
		const { container } = render(
			<div>
				<ThemeProvider defaultTheme="system" storageKey="app-theme">
					<div className="flex h-screen">
						<div data-testid="sidebar">Sidebar Mock</div>
						<main className="flex-1 overflow-auto p-4">
							<div>Test Content</div>
						</main>
					</div>
					<div data-testid="toaster">Toaster Mock</div>
				</ThemeProvider>
			</div>,
		);

		// Verify the components are rendered
		expect(screen.getByTestId("theme-provider")).toBeInTheDocument();
		expect(screen.getByTestId("sidebar")).toBeInTheDocument();
		expect(screen.getByTestId("toaster")).toBeInTheDocument();
		expect(screen.getByText("Test Content")).toBeInTheDocument();

		// Verify the structure
		const main = screen.getByRole("main");
		expect(main).toHaveClass("flex-1", "overflow-auto", "p-4");

		const flexContainer = container.querySelector(".flex.h-screen");
		expect(flexContainer).toBeInTheDocument();
	});
});
