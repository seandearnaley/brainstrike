# @brainstrike/ui

A UI component library built with Shadcn UI components and Tailwind CSS v4.

## Installation

This UI kit is a workspace package. Link it locally rather than fetching it from
the registry.

```bash
# Add to a specific workspace (example: apps/web)
pnpm add @brainstrike/ui --filter @brainstrike/web

# Or declare it manually in the target package.json
"dependencies": {
  "@brainstrike/ui": "workspace:*"
}
```

## Setup

### 1. Import CSS Variables

Add the following import to your main CSS file (e.g., `globals.css`):

```css
@import "tailwindcss";
@import "@brainstrike/ui/globals.css";
```

**Note:** Make sure to import the UI package's CSS _after_ the main Tailwind import.

### 2. Configure PostCSS

Ensure your `postcss.config.mjs` includes the Tailwind PostCSS plugin:

```js
/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    "postcss-import": {},
    "@tailwindcss/postcss": {},
  },
};

export default config;
```

## Usage

Import components directly from the package:

```jsx
import { Button, Input, Dialog } from "@brainstrike/ui";

function MyComponent() {
  return (
    <div>
      <Button variant="default">Click me</Button>
      <Input placeholder="Enter some text" />
    </div>
  );
}
```

## Available Components

The package includes the following components:

- Accordion
- Badge
- Button
- Checkbox
- Dialog
- Input
- Label
- Popover
- Progress
- ScrollArea
- Select
- Switch
- Table
- Tabs
- Toast/Toaster
- Tooltip
- LoadingFallback
- ErrorFallback
- UnsupportedFeature

And utility hooks:

- useToast

## IDE Layout & Panels

`IdeLayout` creates an IDE-style workspace with optional left, right and console panels.
Panel state can persist across sessions with the `usePanelPersistence` hook.

```tsx
import { IdeLayout } from "@brainstrike/ui";
import { usePanelPersistence } from "@brainstrike/ui/hooks";

function MyIde() {
  const panel = usePanelPersistence([25, 20, 30]);

  return (
    <IdeLayout
      navigationItems={[{ title: "Home", href: "/" }]}
      currentPath="/"
      leftPanelContent={<FileExplorer />}
      rightPanelContent={<Tools />}
      consoleContent={<Console />}
    >
      <Editor />
    </IdeLayout>
  );
}
```

## Assistant UI Ownership

The assistant UI package owns presentational chat and control surfaces. Runtime contracts, provider catalogs, memory state, and transport behavior belong outside this package.

Owned surfaces:

- `src/assistant-ui-panel/assistant-ui-panel.tsx`: root assistant panel composition, thread runtime selection, composer shell, message rendering, and provider/model header wiring.
- `src/assistant-ui-panel/assistant-controls-menu.tsx`: reasoning, tool, and provider-settings menu composition.
- `src/assistant-ui-panel/provider-settings-panel.tsx`: per-provider reasoning, output, agent-loop, and memory-control form sections.
- `src/assistant-ui-panel/assistant-message-text.tsx`: markdown/message text rendering.
- `src/assistant-ui-panel/local-runtime-adapter.ts`: browser-safe local runtime adapter surface used by the UI.

Allowed dependencies:

- `@assistant-ui/*` for chat primitives and runtime adapters.
- `@brainstrike/assistant-contract` for UI-facing assistant runtime contracts.
- `@brainstrike/types` for provider settings types shared with preferences/app-shell.
- local shadcn-style primitives from `packages/ui/src`.

Focused local verification:

```bash
pnpm --filter @brainstrike/ui exec vitest run src/__tests__/assistant-ui-panel-architecture.test.ts src/__tests__/assistant-ui-panel.test.tsx src/__tests__/assistant-ui-panel-index.test.ts
pnpm --filter @brainstrike/ui type-check
```
