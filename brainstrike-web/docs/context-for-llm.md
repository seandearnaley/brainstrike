---
description: Provides high-level context about the brainstrike-web project for LLM agents.
globs:
  - "docs/context-for-llm.md"
alwaysApply: true
---
## **High-Level Purpose**

This is a Vite application structured as a multi-app “dashboard.” One core feature is the **File Explorer**, which leverages the browser’s File System Access API (when available) to let users browse and select files on their local system. The layout includes a sidebar, a main content area, and a “Settings” page with theme controls and additional configuration.

---

## **Key Components & Architecture**

1. **File Explorer**  
   - Main Entry: `src/components/custom/FileExplorer.tsx`  
   - Exposes a UI for selecting a root directory, applying filters (include/exclude), previewing file contents, and generating a text-based “report.”  
   - **Hooks**:
     - `useFileExplorer` orchestrates file-tree generation, selection logic, and content loading.  
     - `useFileExplorerSettings` persists user preferences (max selections, filters, etc.) in local storage.  
     - `useFileTree`, `useFileSystem`, and `useFileFilters` handle lower-level logic like reading directories, applying filters, or checking browser compatibility.  
   - **Sub-Components**:
     - `ActionButtons.tsx` (download, copy, select/deselect all).  
     - `FileExplorerConfig.tsx` (popover UI for filters & thresholds).  
     - `FileTree.tsx` & `FileTreeNode.tsx` (tree-based visualization with expand/collapse).  
     - `PreviewPanel.tsx` (file content previews, with text/binary detection).  
     - `SelectionCounter.tsx` (shows selected file count).

2. **Layout & Routing**
   - The main layout consists of a `<Sidebar>` on the left and a `<main>` region on the right.
   - Routing is managed [Describe how routing works - e.g., using React Router, or if it's a single-page app without explicit routing].
   - `Sidebar.tsx`: The minimal vertical panel with navigation links (File Explorer, App 2, Settings) and a theme toggle button.
   - The root layout uses a `<ThemeProvider>` to manage dark/light/system themes.

3. **Settings Page**
   - The Settings view displays various configuration sections (Appearance, "More Settings").
   - `ThemeSettings.tsx` is embedded in this view to switch between light/dark/system.

4. **Testing**
   - **End-to-End** (Playwright) in `e2e/`: covers basic navigation, file-explorer UI flows, layout, and user interactions.
     - `file-explorer.spec.ts` checks initial empty state, settings popover, action buttons, selection counters, etc.
     - `layout.spec.ts` checks rendering of sidebar/main, correct active route.
   - **Unit/Integration** (Vitest + Testing Library) in `src/**/__tests__`, etc.
     - Focus on component behavior (e.g. `FileExplorer.test.tsx`, `SettingsPage.test.tsx`), internal hooks, and coverage of custom logic.

---

## **High-Level Data & Control Flow**

1. **Selecting a Root Directory**  
   - `useFileSystem` checks browser support and calls `window.showDirectoryPicker()`.  
   - If approved, `useFileTree` recursively loads directory contents into a structured `IFileNode` array.

2. **Filtering & Displaying Files**  
   - `useFileFilters` and config from `useFileExplorerSettings` apply filtering rules (glob or regex) before building the final displayed tree.  
   - The final `FileTree` is rendered with directory expand/collapse logic from `useDirectoryExpansion`.

3. **Selecting & Previewing Files**  
   - Each file can be individually toggled, or "Select All"/"Deselect All" can run bulk selection.  
   - For text-based files (below ~1MB), `useFileContentLoading` attempts to read the file content and show it in the `PreviewPanel`.

4. **Generating a Report**  
   - `generateReport` (in `src/utils/reportGenerator.ts`) assembles an XML-like structure with `<relevant_files>` listing each file's content and an optional `<project_tree>` overview.  
   - Users can copy or download this text-based report.

---

## **Tips for Working on the Code**

- **Start with `FileExplorer.tsx`** if you need to change the main explorer UI or selection logic.  
- **Use the relevant hooks** (`useFileExplorer`, `useFileSystem`, `useFileTree`) if you want to modify how files are fetched or filtered.  
- **Look at `tests`** for functional coverage: the e2e specs in `e2e/` and unit tests in `src/**/*test.tsx` show typical usage and desired app behavior.
- **UI Elements** under `src/components/ui/` are mostly reusable, Tailwind-based building blocks (buttons, inputs, popovers, etc.).
- **Theme & Layout** are managed by the root application structure and the custom `ThemeProvider` for light/dark toggles.
