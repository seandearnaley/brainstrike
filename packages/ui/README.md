# @brainstrike/ui

A UI component library built with Shadcn UI components and Tailwind CSS v4.

## Installation

```bash
pnpm add @brainstrike/ui
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

And utility hooks:

- useToast
