# @brainstrike/fonts

Inter font assets packaged for use across BrainStrike apps.

Font paths are resolved relative to this package so they work in both ESM and
CommonJS environments.

## Installation

```bash
pnpm add @brainstrike/fonts
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
