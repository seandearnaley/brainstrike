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

The assistant panel feature moved to `packages/assistant-ui`. This package keeps
the shared shadcn/Radix primitives, model picker, code surfaces, and markdown
building blocks consumed by `@brainstrike/assistant-ui` and other features.

Focused local verification:

```bash
pnpm --filter @brainstrike/ui type-check
```
