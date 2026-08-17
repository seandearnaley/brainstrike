# @brainstrike/file-explorer-ui

React components for displaying and interacting with the file explorer state. These components build upon `@brainstrike/ui` and `@brainstrike/file-explorer` to render file trees, toolbars and related settings screens.

## Virtualization

Large file trees render through the shared `TreeTable` treegrid primitives from
`@brainstrike/ui`. The tree slice owns row-model and lazy-loading composition;
do not reintroduce a package-local virtual-list hook. See `src/tree/README.md`
and the root `AGENTS.md` UI-conventions route before changing this boundary.

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
