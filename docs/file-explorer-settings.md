# File Explorer Settings

This document explains the user configurable options for the file explorer. Settings are stored in **localStorage** under the key `file-explorer-storage-v4`.

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
All of these settings persist across sessions using the `file-explorer-storage-v4` key in localStorage.

Note: Older documentation may reference `fileExplorerSettings`. The current implementation uses the Zustand persist key `file-explorer-storage-v4`.


## Developer: Directory read options

For programmatic directory reads via `packages/file-system`, you can tune performance using `DirectoryReadOptions` on `readDirectory(handle, options)`:

- **includeMetadata**: When false, skip fetching file metadata like `size` and `lastModified` for faster initial listings. Default: true.
- **concurrency**: Max number of concurrent metadata operations (e.g., `fs.stat` on Electron, `getFile()` on Web). Default: 64. Values <= 0 or non-finite are treated as unlimited.

Adapters keep sorting stable (directories first, then names with locale-aware sorting) regardless of options. When `includeMetadata` is false, file nodes may omit `size` and `lastModified`.

Example usage:

```ts
// Faster initial render: defer metadata until needed
const nodes = await adapter.readDirectory(dirHandle, {
  includeMetadata: false,
  concurrency: 64,
});
```

