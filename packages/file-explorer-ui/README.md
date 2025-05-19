# @brainstrike/file-explorer-ui

React components for displaying and interacting with the file explorer state. These components build upon `@brainstrike/ui` and `@brainstrike/file-explorer` to render file trees, toolbars and related settings screens.

## Installation

This package is internal to the `@brainstrike` monorepo and is consumed via workspace linking.

```bash
# From the project root
pnpm add @brainstrike/file-explorer-ui
```

## Usage

```tsx
import { FileTree, FileExplorerSidebar } from "@brainstrike/file-explorer-ui";

function Sidebar() {
  return (
    <FileExplorerSidebar>
      <FileTree />
    </FileExplorerSidebar>
  );
}
```

The components expect state from `useFileExplorerStore` and utilities from `@brainstrike/file-explorer-hooks`.

## Development

```bash
pnpm run build
pnpm run dev # watch mode
pnpm run test
```
