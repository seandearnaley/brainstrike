# @brainstrike/fonts

Inter font assets and utilities packaged for use across BrainStrike apps.

## Installation

```bash
pnpm add @brainstrike/fonts
```

## Usage

### Font Paths

```ts
import { INTER_FONT_PATHS } from "@brainstrike/fonts";

const fontUrl = INTER_FONT_PATHS.variable;
const italicFontUrl = INTER_FONT_PATHS.variableItalic;
```

### CSS Font-Face Generation

```ts
import { generateInterFontFaces } from "@brainstrike/fonts";

// Generate CSS font-face declarations
const fontFaceCSS = generateInterFontFaces();

// Or with custom base path
const customFontFaceCSS = generateInterFontFaces('/custom/fonts/path');
```

### Font Family Constants

```ts
import { INTER_FONT_FAMILY } from "@brainstrike/fonts";

// Use in CSS-in-JS or Tailwind config
const styles = {
  fontFamily: INTER_FONT_FAMILY,
};
```

### Available Font Files

```ts
import { INTER_FONT_FILES } from "@brainstrike/fonts";

// Iterate over available font files
INTER_FONT_FILES.forEach(file => {
  console.log(`Available font: ${file}`);
});
```

## Integration with Vite

This package works seamlessly with the Vite build system in `apps/web`. The font files are automatically copied from this package to the public directory during development and build processes.

## Font Details

- **Family**: Inter Variable
- **Formats**: TrueType (.ttf)  
- **Weight Range**: 100-900
- **Styles**: Normal, Italic
- **Features**: Variable font with full weight range
