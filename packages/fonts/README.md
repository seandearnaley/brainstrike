# @brainstrike/fonts

Inter font assets packaged for use across BrainStrike apps.

Font paths are resolved relative to this package so they work in both ESM and
CommonJS environments.

## Installation

Consume the font package through the workspace—there is no published registry
version.

```bash
# Add to a specific workspace (example: apps/web)
pnpm add @brainstrike/fonts --filter @brainstrike/web

# Or pin it directly inside the target package.json
"dependencies": {
  "@brainstrike/fonts": "workspace:*"
}
```

## Usage

```ts
import { INTER_FONT_PATHS } from "@brainstrike/fonts";

const fontUrl = INTER_FONT_PATHS.variable;
```

When building the web or Electron applications, make sure the font files from
`packages/fonts/src/inter` are copied into your `public/fonts` (for web) or
`dist/fonts` (for Electron) directory. The web application already includes a
Vite plugin that performs this copy.
