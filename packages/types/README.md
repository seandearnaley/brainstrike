# @brainstrike/types

Shared TypeScript interfaces, constants and error classes used across Brainstrike packages. It provides the shape of the file explorer state and common utility types.

## Installation

Link the shared types into the consuming workspace via pnpm’s workspace
protocols.

```bash
# Add to a specific workspace (example: packages/utils)
pnpm add @brainstrike/types --filter @brainstrike/utils

# Or declare it directly inside the target package.json
"dependencies": {
  "@brainstrike/types": "workspace:*"
}
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
