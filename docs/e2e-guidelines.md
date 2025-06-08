# Playwright E2E Guidelines

These unified rules help keep end-to-end tests reliable across all Brainstrike applications.

1. **Group related tests with `test.describe`** and use `test.beforeEach` for shared setup.
2. **Navigate to the app and wait for it to load** using `page.goto('/')` followed by `waitForAppLoad(page)`.
3. **Use stable locators** (`getByRole`, `aria-label`, or data attributes) instead of loose text selectors.
4. **Mock the file system with `mockBrowserApis`** to provide predictable test data.
5. **Access nested files via the filter + Expand All pattern** instead of clicking individual chevrons.
6. **Reset persistent state** with helpers like `resetLayoutState` and `resetFileExplorerSettings` to keep tests independent.
7. **Leverage layout helpers** (`getPanelElements`, `togglePanelVisibility`, `resizePanel`) for panel interactions.
8. **Prefer flexible assertions** for counts and text visibility rather than exact values.
9. **Set an explicit theme when testing theme switching** and wait briefly for the DOM to update.
10. **Await asynchronous actions** (downloads, clipboard copy) before verifying results.
11. **Keep each test focused on user‑visible behavior**, avoiding implementation details.
12. **Run tests via `pnpm test:e2e`** locally or in CI to ensure consistent headless execution.
