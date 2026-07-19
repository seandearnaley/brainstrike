# @brainstrike/file-explorer-ui

React components for displaying and interacting with the file explorer state. These components build upon `@brainstrike/ui` and `@brainstrike/file-explorer` to render file trees, toolbars and related settings screens.

## Virtualization

The `FileTree` component uses a small in-house virtualization hook to render only the visible rows of very large trees. This dramatically improves performance when dealing with thousands of files.

## Installation

This package ships as part of the Brainstrike Turborepo. Link it to another
workspace instead of pulling from the public registry.

```bash
# Add to a specific workspace (example: the web app)
pnpm add @brainstrike/file-explorer-ui --filter @brainstrike/web

# Or declare it manually inside the target package.json
"dependencies": {
  "@brainstrike/file-explorer-ui": "workspace:*"
}
```

## Usage

```tsx
import { AdaptersProvider } from "@brainstrike/file-explorer-hooks";
import { MemoryStorageAdapter } from "@brainstrike/storage";
import {
  FileExplorerProvider,
  FileExplorerSidebar,
  FileTree,
} from "@brainstrike/file-explorer-ui";

function Sidebar() {
  return (
    <AdaptersProvider
      fileSystemAdapter={/* platform specific adapter */}
      storageAdapter={new MemoryStorageAdapter()}
    >
      <FileExplorerProvider storageAdapter={new MemoryStorageAdapter()}>
        <FileExplorerSidebar>
          <FileTree />
        </FileExplorerSidebar>
      </FileExplorerProvider>
    </AdaptersProvider>
  );
}
```

Providers from `@brainstrike/file-explorer-hooks` and
`@brainstrike/file-explorer` must wrap these components so they can resolve the
Zustand store and worker helpers.

## Development

```bash
pnpm run build
pnpm run dev # watch mode
pnpm run test
```
