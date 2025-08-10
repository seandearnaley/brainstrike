import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

export class FileExplorerPage {
  constructor(public readonly page: Page) {}

  get selectRootButton(): Locator {
    return this.page.getByRole("button", { name: "Select Root" });
  }

  get openSettingsButton(): Locator {
    return this.page.getByRole("button", { name: "Open settings" });
  }

  get fileTree(): Locator {
    return this.page.getByRole("tree", { name: "File tree" });
  }

  get fileTreeScrollContainer(): Locator {
    return this.page.locator('[data-testid="file-tree-scroll-container"]');
  }

  get noDirectoryText(): Locator {
    return this.page.getByText("No directory selected");
  }

  get noFilesText(): Locator {
    return this.page.getByText("No files selected");
  }

  get filterInput(): Locator {
    return this.page.getByPlaceholder(
      "Type to filter files... (e.g. 'test component -spec')"
    );
  }

  get downloadReportButton(): Locator {
    return this.page.getByRole("button", { name: "Download Report" });
  }

  get copyReportButton(): Locator {
    return this.page
      .locator(
        'button:has-text("Copy Report"), button:has-text("Copy"):not(:has-text("Copy Report"))'
      )
      .first();
  }

  get selectAllButton(): Locator {
    return this.page.getByRole("button", { name: "Select All" });
  }

  async selectRoot(): Promise<void> {
    await this.selectRootButton.click();

    // Wait for the tree to be visible with a longer timeout
    // This should work for both regular and performance tests
    await expect(this.fileTree).toBeVisible({ timeout: 30000 });
  }

  /**
   * Scrolls the virtualized file tree until a file/folder text is rendered,
   * then ensures it is visible in the viewport.
   */
  async revealInTree(
    text: string,
    stepPx = 800,
    maxSteps = 40
  ): Promise<boolean> {
    const fileTree = this.fileTree;
    const container = this.fileTreeScrollContainer;

    // Try current viewport first
    const tryFocusVisible = async (): Promise<boolean> => {
      // Prefer the treeitem by accessible name, fallback to text span
      const locItem = fileTree.getByRole("treeitem", { name: text }).first();
      const itemCount = await locItem.count();
      const loc = itemCount > 0 ? locItem : fileTree.getByText(text).first();
      if ((await loc.count()) === 0) return false;

      // Center the row (treeitem) within the scroll container to maximize visibility
      await this.page.evaluate(
        ([containerEl, targetEl]) => {
          if (!containerEl || !targetEl) return;
          const container = containerEl as HTMLElement;
          const textEl = targetEl as HTMLElement;
          const row =
            (textEl.closest('[role="treeitem"]') as HTMLElement) || textEl;
          const targetTop = row.offsetTop ?? 0;
          const centerOffset = Math.max(
            0,
            (container.clientHeight - row.clientHeight) / 2
          );
          const desiredTop = Math.max(0, targetTop - centerOffset);
          container.scrollTop = desiredTop;
        },
        [await container.elementHandle(), await loc.elementHandle()]
      );

      // Wait until the virtual list settles before measuring visibility
      await this.waitForTreeStable(60, 2);

      return await this.isTextInContainerView(text);
    };

    if (await tryFocusVisible()) return true;

    // Scroll down in steps until the element appears
    for (let i = 0; i < maxSteps; i++) {
      await container.evaluate((el, dy) => {
        el.scrollTop = Math.min(el.scrollTop + (dy as number), el.scrollHeight);
      }, stepPx);
      // Give virtualization time to render
      await this.page.waitForTimeout(50);
      if (await tryFocusVisible()) return true;
    }

    // Try from bottom upwards (in case list is near end)
    await container.evaluate(
      (el) => (el.scrollTop = (el as HTMLElement).scrollHeight)
    );
    await this.page.waitForTimeout(50);
    if (await tryFocusVisible()) return true;
    for (let i = 0; i < maxSteps; i++) {
      await container.evaluate((el, dy) => {
        el.scrollTop = Math.max(el.scrollTop - (dy as number), 0);
      }, stepPx);
      await this.page.waitForTimeout(50);
      if (await tryFocusVisible()) return true;
    }

    // If still not found, reset to top and return (caller can assert/ retry)
    await container.evaluate((el) => (el.scrollTop = 0));
    return false;
  }

  /**
   * Waits for the virtualized tree to stabilize based on scrollHeight readings.
   * Prevents asserting while layout/virtualization is still painting.
   */
  async waitForTreeStable(frameMs = 50, stableReads = 2): Promise<void> {
    const cont = this.fileTreeScrollContainer;
    let lastHeight = -1;
    let stable = 0;
    for (let i = 0; i < 40; i++) {
      const h = await cont.evaluate((el) => (el as HTMLElement).scrollHeight);
      if (h === lastHeight) {
        stable += 1;
        if (stable >= stableReads) return;
      } else {
        stable = 0;
        lastHeight = h as number;
      }
      await this.page.waitForTimeout(frameMs);
    }
  }

  async scrollTreeToTop(): Promise<void> {
    await this.fileTreeScrollContainer.evaluate((el) => (el.scrollTop = 0));
    await this.page.waitForTimeout(50);
  }

  async scrollTreeToBottom(): Promise<void> {
    await this.fileTreeScrollContainer.evaluate(
      (el) => (el.scrollTop = el.scrollHeight)
    );
    await this.page.waitForTimeout(50);
  }

  async ensureVisibleText(text: string): Promise<void> {
    // Retry a few times and poll for container-relative visibility
    for (let attempt = 0; attempt < 5; attempt++) {
      const found = await this.revealInTree(text);
      if (!found) {
        // small nudge to trigger render
        await this.fileTreeScrollContainer.evaluate((el) => {
          const c = el as HTMLElement;
          c.scrollTop = Math.min(c.scrollHeight, c.scrollTop + 80);
        });
        await this.page.waitForTimeout(40);
      }
      await this.waitForTreeStable(50, 2);
      const visible = await this.isTextInContainerView(text);
      if (visible) return;
    }
    // Final assertion with informative error if still not visible
    const visible = await this.isTextInContainerView(text);
    expect(
      visible,
      `Text '${text}' not visible in file tree container after retries`
    ).toBe(true);
  }

  async waitForTextToExist(text: string, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    const loc = this.fileTree.getByText(text).first();
    // quick path
    if ((await loc.count()) > 0) return;
    while (Date.now() - start < timeoutMs) {
      if ((await loc.count()) > 0) return;
      await this.page.waitForTimeout(50);
    }
    expect(
      await loc.count(),
      `Text '${text}' did not appear within ${timeoutMs}ms`
    ).toBeGreaterThan(0);
  }

  private async isTextInContainerView(text: string): Promise<boolean> {
    const fileTree = this.fileTree;
    const container = this.fileTreeScrollContainer;
    const loc = fileTree.getByText(text).first();
    if ((await loc.count()) === 0) return false;
    return await this.page.evaluate(
      ([containerEl, targetEl]) => {
        if (!containerEl || !targetEl) return false;
        const container = containerEl as HTMLElement;
        const textEl = targetEl as HTMLElement;
        const row =
          (textEl.closest('[role="treeitem"]') as HTMLElement) || textEl;
        const style = window.getComputedStyle(row);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          parseFloat(style.opacity || "1") === 0
        )
          return false;
        const ct = container.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        const verticallyVisible = rr.bottom > ct.top && rr.top < ct.bottom;
        const horizontallyVisible = rr.right > ct.left && rr.left < ct.right;
        return (
          verticallyVisible &&
          horizontallyVisible &&
          rr.height > 0 &&
          rr.width > 0
        );
      },
      [await container.elementHandle(), await loc.elementHandle()]
    );
  }

  async getCheckbox(name: string): Promise<import("@playwright/test").Locator> {
    await this.ensureVisibleText(name);
    return this.fileTree.getByRole("checkbox", { name: `Select ${name}` });
  }
}
