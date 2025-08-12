import { expect, test } from "@playwright/test";
import { FileExplorerPage } from "./page-objects/file-explorer-page";
import { resetAppState } from "./utils/app-state";
import { type FileTree, mockBrowserApis } from "./utils/mock-fs";
import { waitForAppLoad } from "./utils/layout-helpers";

test.describe("File Explorer - Filter Functionality", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => { (window as any).__PW_TEST__ = true; });
    
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
    // Our checkboxes use accessible name "Select <filename>"
    const fileCheckbox = (name: string) => fileTree.getByRole("checkbox", { name: `Select ${name}`, exact: true });
    const filterInput = page.getByPlaceholder(
      "Type to filter files... (e.g. 'test component -spec')"
    );
    const explorer = new FileExplorerPage(page);

    // Search for "Button"
    await filterInput.fill("Button");
    await explorer.waitForTreeStable(80, 3);
    await page.waitForTimeout(700);
    await expect(fileCheckbox("Button.tsx")).toBeVisible();
    await expect(fileCheckbox("Button.test.tsx")).toBeVisible();
    
    // Assert only file checkboxes (files) in view match "Button"
    const labels = await fileTree.getByRole('checkbox').all();
    const aria = (await Promise.all(labels.map(el => el.getAttribute('aria-label')))).filter(Boolean);
    expect(new Set(aria)).toEqual(new Set(['Select Button.tsx', 'Select Button.test.tsx']));
    await expect(fileTree.getByRole('checkbox')).toHaveCount(2);

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
    await page.waitForTimeout(300);
    await explorer.waitForTextToExist("Button.test.tsx", 3000);
    await expect(fileCheckbox("Button.test.tsx")).toBeVisible();
    await expect(fileCheckbox("utils.test.ts")).toBeVisible();

    // Search for "utils -test" (exclude test files)
    await filterInput.fill("utils -test");
    await explorer.waitForTreeStable(80, 3);
    await page.waitForTimeout(300);
    await explorer.waitForTextToExist("utils.ts", 3000);
    await expect(fileCheckbox("utils.ts")).toBeVisible();
  });
});
