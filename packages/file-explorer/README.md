# @brainstrike/file-explorer

Core state management and actions for the Brainstrike file explorer feature. This package exposes a Zustand store along with helper actions for expanding directories, selecting files and managing preferences.

## Installation

This package is internal to the `@brainstrike` monorepo and is consumed via workspace linking.

```bash
# From the project root
pnpm add @brainstrike/file-explorer
```

## Usage

```ts
import { createFileExplorerStore } from "@brainstrike/file-explorer";
import { createMemoryStorageAdapter } from "@brainstrike/storage";

const store = createFileExplorerStore(createMemoryStorageAdapter());
const { expandedDirectoryPaths, expandDirectory } = store.getState();

expandDirectory("/src/components");
```

The store also includes actions for selecting files, persisting folder states and updating settings.

## Development

```bash
pnpm run build
pnpm run dev # watch mode
pnpm run test
```
