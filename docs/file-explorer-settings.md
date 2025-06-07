# File Explorer Settings

This document explains the user configurable options for the file explorer. Settings are stored in **localStorage** under the key `fileExplorerSettings`.

## Settings

### `maxSelectionCount`
Maximum number of files that can be selected at once. The UI prevents selecting more than this value. Default: **10**.

### `includeFilters` / `excludeFilters`
Arrays of glob patterns or regexes used to filter visible files. `includeFilters` controls which files appear, while `excludeFilters` hides matching entries. Defaults:

- `includeFilters`: `['*.tsx', '*.ts', '*.js', '*.jsx', '*.json']`
- `excludeFilters`: `['.aider*', 'node_modules', '.next', 'coverage', 'test-results', 'playwright-report']`

### `useRegex`
When enabled, treat filter patterns as regular expressions instead of globs. Default: **false**.

### `includeProjectTree`
Show the entire project tree in the explorer. If disabled, only the selected folder is displayed. Default: **true**.

### `folderSummaryThreshold`
Number of files in a folder before the **project tree in the generated report** collapses them into a summary row. This setting does **not** affect the file explorer UI. Default: **5**.

## Storage Key
All of these settings persist across sessions using the `fileExplorerSettings` key in localStorage.

