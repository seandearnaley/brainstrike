# @brainstrike/types

Shared TypeScript interfaces, constants and error classes used across Brainstrike packages. It provides the shape of the file explorer state and common utility types.

## Installation

```bash
pnpm add @brainstrike/types
```

## Usage

```ts
import type { FileExplorerState, FileContents } from "@brainstrike/types";

const state: FileExplorerState = {
  currentFolderId: null,
  folderStates: {},
  selectedFilePaths: new Set(),
  expandedDirectoryPaths: new Set(),
  lastActiveTab: "files",
};
```

The package also exports constants and error classes such as `FileContentError` and `ConcurrentLoadingError`.

## Development

```bash
pnpm run build
pnpm run dev # watch mode
pnpm run test
```
