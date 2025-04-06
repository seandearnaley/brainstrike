## High-Level Overview

Our file explorer is composed of:

1. A **Zustand store** (`useFileExplorerStore.ts`) that persists key user state (selected files, directory expansions, filtering preferences) to local storage.

2. A **FileExplorer** component that coordinates UI concerns (selecting root directory, refreshing, rendering filters, etc.). It leverages various custom hooks (e.g., `useFileExplorer`, `useQuickFilter`, `useFileExplorerSettings`).

3. A **FileTree** (and `FileTreeNode`) hierarchy that renders directories, files, and checkboxes for selection and expansion.

4. A **FileExplorerConfig** popover for user-adjustable settings (filters, max selection, folder summary threshold). This merges ephemeral config changes with the Zustand store’s persisted settings.

5. Several smaller utilities and hooks:
   - **`useFileTree.ts`**: reads the actual file structure from the browser’s File System Access API or from the user’s OS.  
   - **`useFileFilters.ts`**: applies include/exclude patterns.  
   - **`useFileContentLoading.ts`**: fetches file contents, displays loading spinners as needed.  
   - **`useQuickFilter`**: short ephemeral text filter for quickly narrowing the displayed tree.  
   - **`useFileSystem`**: checks browser compatibility and opens the directory picker.

---

## The Zustand Store: `useFileExplorerStore.ts`

- **Purpose**: Provide a single “source of truth” for which files are selected, which directories are expanded, and what filtering preferences (includeFilters, excludeFilters, useRegex) the user has chosen.  

- **Persistence**:  
  We use `zustand` with `persist`. This means `selectedFilePaths`, `expandedDirectoryPaths`, etc. are saved in `localStorage`. Upon reload, we `rehydrate` the store so the user’s session picks up where it left off.  

- **Major Methods**:  
  - `addSelectedFile`, `removeSelectedFile`, `clearSelectedFiles` for toggling a user’s selection.  
  - `toggleDirectoryExpansion` for expanding/collapsing directories.  
  - `setFilters`, `setUseRegex` to store filtering preferences.  
  - `setIncludeProjectTree`, `setFolderSummaryThreshold` for controlling optional UI behaviors (e.g., how many child files to show before summarizing a folder).

- **Why a Store?**  
  - We can easily share these states across the entire React tree.  
  - Persisting in local storage means the user doesn’t lose their expansions or selections if they close the browser tab.

---

## `FileExplorer` Component

**FileExplorer** is the central UI piece. It:

1. Provides top-level controls:
   - **Select Root** (calls `useFileSystem` to open the directory picker).
   - **Refresh** (calls `refreshFileExplorer` from our main hook).
   - **FileExplorerConfig** (opens a settings popover for filters and thresholds).

2. Renders a **FileFilterBar** for quick text-based filtering (e.g., typed patterns).

3. Shows the **FileTree** on the left half and a **PreviewPanel** / **GitPanel** on the right half (using a Tabs layout).

4. Hosts the **ActionButtons** in its footer:
   - *Select All / Deselect All* 
   - *Download Report*
   - *Copy Report*

### Interaction Flow Example
- When the user checks a file’s checkbox in **FileTreeNode**, that calls `onToggleFileSelection` → store’s `addSelectedFile` or `removeSelectedFile`.
- The store updates persist to local storage. The user can refresh the page, and those selections remain.

---

## `FileTree` and `FileTreeNode`

- **`FileTree.tsx`**: A memoized list of nodes. It pulls from the store’s `expandedDirectoryPaths` and `selectedFilePaths` to see which nodes are expanded and which are selected.
- **`FileTreeNode.tsx`**: A recursive component that can render either a directory or a file:
  - **Directory**: 
    - Has a tri-state checkbox (unchecked, checked, indeterminate).  
    - If the user checks a directory, we recursively select all child files.  
    - If all child files are selected, unchecking the directory unselects them.  
    - A small toggle button (chevron) expands/collapses the directory.
  - **File**: 
    - Regular single checkbox to select/deselect that file.  
    - No expand/collapse button.  

**Why recursive?** Because directories can contain subdirectories infinitely. This pattern suits a typical file tree.

---

## `FileExplorerConfig` (Settings Popover)

- **Location**: Typically triggered by a gear icon.  
- **What It Does**: Renders a popover with:
  - Filter patterns (`includeFilters`, `excludeFilters`), plus a “Use Regex” toggle.
  - `folderSummaryThreshold` (determines how many child files to show before summarizing).
  - `maxSelectionCount` (though we store it in a separate user setting).
  - A “Project Tree” toggle (some UIs show/hide the entire tree).

When the user hits **“Apply Settings”**:
1. Local ephemeral inputs are read.
2. We call store actions like `setFilters`, `setUseRegex`, or `setIncludeProjectTree`.
3. The hooking logic calls `applyFileFilters` to re-filter the tree if needed.
4. The popover closes.

---

## Additional Hooks & Utilities

1. **`useFileSystem`**: 
   - Checks if the user’s browser supports the File System Access API. 
   - If so, calls `showDirectoryPicker()` to get a directory handle. 
   - We store that handle in memory (the store doesn’t typically store the entire handle in local storage because that’s not re-hydratable in a standard way).

2. **`useFileTree`**:
   - When the user picks a directory handle, we parse it to build a typed tree of directories/files. 
   - We handle partial read errors, show them in the UI if needed.

3. **`useFileFilters`**:
   - Matches paths against `includeFilters` / `excludeFilters`. 
   - Optional regex mode or glob patterns. 
   - We keep a small `filterError` for invalid patterns.

4. **`useFileContentLoading`**:
   - Manages retrieving file contents for preview. 
   - Doesn’t persist these contents in local storage. 
   - If the user toggles a file as “selected,” the app might load its contents on demand for preview.

5. **`ActionButtons`**:
   - The bottom row of “Select All / Deselect All / Download / Copy” controls. 
   - “Select All” means “select all displayed files,” i.e., the files currently passing the filters. 
   - “Deselect All” clears the store’s `selectedFilePaths`. 
   - “Download” triggers a `generateReport(...)` call, which collects the selected files’ contents. 
   - “Copy” does the same but writes the resulting report to the clipboard.

6. **`PreviewPanel`**:
   - Shows file contents for selected files. 
   - The user can remove a file from selection with a small “X” button. 
   - This also calls the store’s `removeSelectedFile` or `setSelectedFiles`.

---

## Putting It All Together

1. **User picks a directory**  
   - `Select Root` button → `useFileSystem` → user chooses a folder → `useFileTree` reads it → we store the resulting file structure in memory.

2. **We apply filters**  
   - The store holds `includeFilters`, `excludeFilters`, and `useRegex`.  
   - The filtered result is computed by `useFileFilters`, plus ephemeral quick filters from `useQuickFilter`. 
   - We store the final “filtered tree” in local UI state for rendering.

3. **We display**  
   - The left half shows `FileTree`, which recurses through directories. The right half shows a tab-based “Preview” (for file contents) or “Git” panel (for commits, branches, diffs).

4. **Selecting & Expanding**  
   - Toggling any file or directory’s checkbox manipulates `selectedFilePaths` in the store. 
   - Expanding a directory toggles `expandedDirectoryPaths`. 
   - All these changes are automatically persisted to local storage (via `zustand`’s `persist`).

5. **Reporting**  
   - The user can click “Download Report” or “Copy Report.” 
   - We gather all selected files from `selectedFilePaths`, possibly read their contents via `useFileContentLoading`, and build a custom text or JSON. 
   - For “Download,” we write to disk (`file-saver` or standard HTML5 APIs). For “Copy,” we use the Clipboard API.

6. **Re-Hydration**  
   - If the user closes the browser or refreshes, upon re-opening the app, we rehydrate the store from local storage. 
   - The user sees the same expansions, selections, and filter rules as before.

---

## In Summary

- **Zustand** is our single store for user preferences, expansions, and selections. 
- **FileExplorer** is the central orchestrator, hooking up the store data (filters, expansions) to child components (`FileTree`, `PreviewPanel`, etc.). 
- **FileExplorerConfig** provides a popover-based interface for updating the store’s filters & thresholds. 
- **`useFileTree`, `useFileFilters`, and `useFileContentLoading`** each do a specific job: reading directory structures, filtering them, and loading file contents for preview. 
- **Local storage** ensures the user can pick up where they left off after a page refresh, while ephemeral states (like ephemeral text filters or loading states) remain purely local.

This design cleanly separates domain concerns:
- The store solves “what’s selected/expanded” and “which filters do I persist?”
- The hooks each do a specialized job (listing files, applying filters, loading contents).
- The UI components simply read from the store (or from ephemeral states) and render accordingly.

That’s **how it all works**—the result is a modular file explorer architecture that’s easy to extend, test, and reason about.