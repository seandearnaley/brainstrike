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

## Actions Ownership

The file-explorer actions layer owns store mutations and keeps UI concerns out of the core package.

Owned surfaces:

- `src/actions/file-selection-actions.ts`: selection mutation commands, query-selection mutation support, chunked large-selection handling, cancellation, and max-selection enforcement.
- `src/actions/__tests__/file-selection-actions.test.ts`: executable behavior coverage for explicit selection, query selection, batch mutation, and chunked mutation.
- `src/actions/__tests__/file-selection-actions-null-folder.test.ts`: focused early-return behavior for null folder ids.
- `src/actions/__tests__/file-selection-actions-test-support.ts`: shared action-test fixture for selection mocks and full store state construction.

Allowed dependencies:

- `@brainstrike/types` for the canonical file-explorer state and selection model.
- `@brainstrike/utils/selection-utils` for composite selection key encoding.
- `@brainstrike/utils/logger` for action logging.

Focused local verification:

```bash
pnpm --filter @brainstrike/file-explorer exec vitest run src/__tests__/actions-architecture.test.ts src/actions/__tests__/file-selection-actions.test.ts src/actions/__tests__/file-selection-actions-null-folder.test.ts
pnpm --filter @brainstrike/file-explorer build
```

## Development

```bash
pnpm run build
pnpm run dev # watch mode
pnpm run test
```
