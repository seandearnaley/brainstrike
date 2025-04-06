import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	Toast,
	ToastAction,
	ToastClose,
	ToastDescription,
	ToastProvider,
	ToastTitle,
	ToastViewport,
} from "../toast";

// Mock hasPointerCapture
beforeAll(() => {
	// @ts-ignore - we need to mock this for userEvent
	Element.prototype.hasPointerCapture = () => false;
});

const TestProvider = ({ children }: { children: React.ReactNode }) => (
	<ToastProvider>
		{children}
		<ToastViewport />
	</ToastProvider>
);

describe("Toast Components", () => {
	describe("Toast", () => {
		it("renders with default variant", () => {
			render(
				<TestProvider>
					<Toast>Test Toast</Toast>
				</TestProvider>,
			);
			const toastElement = screen
				.getAllByRole("status")
				.find((el) => el.textContent === "Test Toast");
			expect(toastElement).toBeDefined();
			expect(toastElement).toHaveClass(
				"border",
				"bg-background",
				"text-foreground",
			);
			expect(screen.getByText("Test Toast")).toBeInTheDocument();
		});

		it("renders with destructive variant", () => {
			render(
				<TestProvider>
					<Toast variant="destructive">Destructive Toast</Toast>
				</TestProvider>,
			);
			const toastElement = screen
				.getAllByRole("status")
				.find((el) => el.textContent === "Destructive Toast");
			expect(toastElement).toBeDefined();
			expect(toastElement).toHaveClass(
				"destructive",
				"border-destructive",
				"bg-destructive",
				"text-destructive-foreground",
			);
			expect(screen.getByText("Destructive Toast")).toBeInTheDocument();
		});
	});

	describe("ToastAction", () => {
		it("renders action button with correct styles", async () => {
			const handleAction = vi.fn();
			const user = userEvent.setup();

			render(
				<TestProvider>
					<Toast>
						<ToastAction altText="Undo action" onClick={handleAction}>
							Undo
						</ToastAction>
					</Toast>
				</TestProvider>,
			);

			const button = screen.getByRole("button", { name: "Undo" });
			expect(button).toHaveClass(
				"inline-flex",
				"h-8",
				"shrink-0",
				"items-center",
				"justify-center",
				"rounded-md",
				"border",
				"bg-transparent",
			);

			await user.click(button);
			expect(handleAction).toHaveBeenCalled();
		});
	});

	describe("ToastClose", () => {
		it("renders close button with X icon", () => {
			render(
				<TestProvider>
					<Toast>
						<ToastClose />
					</Toast>
				</TestProvider>,
			);
			const button = screen.getByRole("button", { name: "" });
			expect(button).toHaveAttribute("toast-close", "");
			expect(button).toHaveClass("absolute", "right-2", "top-2");
		});
	});

	describe("ToastTitle", () => {
		it("renders title with correct styles", () => {
			render(
				<TestProvider>
					<Toast>
						<ToastTitle>Important Message</ToastTitle>
					</Toast>
				</TestProvider>,
			);
			const title = screen.getByText("Important Message");
			expect(title).toHaveClass("text-sm", "font-semibold");
		});
	});

	describe("ToastDescription", () => {
		it("renders description with correct styles", () => {
			render(
				<TestProvider>
					<Toast>
						<ToastDescription>Additional details here</ToastDescription>
					</Toast>
				</TestProvider>,
			);
			const description = screen.getByText("Additional details here");
			expect(description).toHaveClass("text-sm", "opacity-90");
		});
	});

	describe("ToastViewport", () => {
		it("renders viewport with correct styles", () => {
			render(
				<TestProvider>
					<Toast>Test Toast</Toast>
				</TestProvider>,
			);
			const viewport = screen.getByRole("list");
			expect(viewport).toHaveClass(
				"fixed",
				"bottom-0",
				"right-0",
				"z-100",
				"flex",
				"max-h-screen",
				"w-full",
				"flex-col-reverse",
				"gap-2",
				"p-4",
				"sm:max-w-[420px]",
			);
		});
	});

	describe("Integration", () => {
		it("renders a complete toast with all components", () => {
			const handleAction = vi.fn();

			render(
				<TestProvider>
					<Toast>
						<div className="grid gap-1">
							<ToastTitle>Notification</ToastTitle>
							<ToastDescription>This is a test notification</ToastDescription>
						</div>
						<ToastAction altText="Test action" onClick={handleAction}>
							Action
						</ToastAction>
						<ToastClose />
					</Toast>
				</TestProvider>,
			);

			expect(screen.getByText("Notification")).toBeInTheDocument();
			expect(
				screen.getByText("This is a test notification"),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Action" }),
			).toBeInTheDocument();

			// Find close button by attribute instead of role+name
			const closeButton = screen.getByRole("button", { name: "" });
			expect(closeButton).toHaveAttribute("toast-close");
		});
	});
});
