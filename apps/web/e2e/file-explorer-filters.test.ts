import { expect, test } from "@playwright/test";
import { resetAppState } from "./utils/app-state";
import { type FileTree, mockBrowserApis } from "./utils/mock-fs";
import { waitForAppLoad } from "./utils/layout-helpers";

test.describe("File Explorer - Filter Functionality", () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      "Button.tsx": null,
      "Button.test.tsx": null,
      "utils.ts": null,
      "utils.test.ts": null,
      "config.json": null,
      "package.json": null,
      "legacy.js": null,
      "OldComponent.jsx": null,
      my_custom_modules: {
        "some-package": {
          "index.js": null,
        },
      },
      my_custom_coverage: {
        "lcov.info": null,
      },
    };

    await mockBrowserApis(page, "test-project", tree);

    await page.goto("/");
    await waitForAppLoad(page);
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page);

    await expect(page.getByText("No directory selected")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText("No files selected")).toBeVisible({
      timeout: 15000,
    });

    await page.getByTestId("select-root-button").click();

    await expect(
      page.getByPlaceholder(
        "Type to filter files... (e.g. 'test component -spec')"
      )
    ).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("No directory selected")).not.toBeVisible();
    await expect(page.getByRole("tree", { name: "File tree" })).toBeVisible();
  });

  test("should filter files using text search", async ({ page }) => {
    const fileTree = page.getByRole("tree", { name: "File tree" });
    const filterInput = page.getByPlaceholder(
      "Type to filter files... (e.g. 'test component -spec')"
    );
    const { FileExplorerPage } = await import(
      "./page-objects/file-explorer-page"
    );
    const explorer = new FileExplorerPage(page);

    // Search for "Button"
    await filterInput.fill("Button");
    await page.waitForTimeout(500); // Allow filter to take effect
    await expect(fileTree.getByText("Button.tsx")).toBeVisible();
    await expect(fileTree.getByText("Button.test.tsx")).toBeVisible();
    await expect(fileTree.getByText("utils.ts")).not.toBeVisible();
    await expect(fileTree.getByText("package.json")).not.toBeVisible();

    // Clear filter and wait for list to repopulate
    await filterInput.fill("");
    await explorer.waitForTreeStable(80, 3);
    await explorer.waitForTextToExist("Button.tsx", 3000);
    // Virtualized list: reveal by scrolling if not immediately in viewport
    await explorer.ensureVisibleText("Button.tsx");
    await explorer.ensureVisibleText("utils.ts");

    // Search for ".test"
    await filterInput.fill(".test");
    await explorer.waitForTreeStable(80, 3);
    await explorer.waitForTextToExist("Button.test.tsx", 3000);
    await expect(fileTree.getByText("Button.test.tsx")).toBeVisible();
    await expect(fileTree.getByText("utils.test.ts")).toBeVisible();
    await expect(fileTree.getByText("Button.tsx")).not.toBeVisible();
    await expect(fileTree.getByText("utils.ts")).not.toBeVisible();

    // Search for "utils -test" (exclude test files)
    await filterInput.fill("utils -test");
    await explorer.waitForTreeStable(80, 3);
    await explorer.waitForTextToExist("utils.ts", 3000);
    await expect(fileTree.getByText("utils.ts")).toBeVisible();
    await expect(fileTree.getByText("utils.test.ts")).not.toBeVisible();
    await expect(fileTree.getByText("Button.tsx")).not.toBeVisible();
  });
});
