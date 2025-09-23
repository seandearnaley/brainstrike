# @brainstrike/file-explorer

Core state management and actions for the Brainstrike file explorer feature. This package exposes a Zustand store along with helper actions for expanding directories, selecting files and managing preferences.

## Installation

This store lives inside the Brainstrike monorepo. Link it into another
workspace rather than pulling it from a registry.

```bash
# Add to a specific workspace (example: the desktop app)
pnpm add @brainstrike/file-explorer --filter @brainstrike/desktop

# Or declare it manually inside that workspace package.json
"dependencies": {
  "@brainstrike/file-explorer": "workspace:*"
}
```

## Usage

```ts
import { useFileExplorerStore } from "@brainstrike/file-explorer";

const { expandedDirectoryPaths, expandDirectory } = useFileExplorerStore();

expandDirectory("/src/components");
```

The store also includes actions for selecting files, persisting folder states and updating settings.

## Development

```bash
pnpm run build
pnpm run dev # watch mode
pnpm run test
```
