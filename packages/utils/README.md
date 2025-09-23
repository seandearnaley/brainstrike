# @brainstrike/utils

This package contains shared utility functions used across the Brainstrike project.

## Installation

Link the utilities package into the consuming workspace using pnpm.

```bash
# Add to a specific workspace (example: apps/web)
pnpm add @brainstrike/utils --filter @brainstrike/web

# Or declare it manually inside the target package.json
"dependencies": {
  "@brainstrike/utils": "workspace:*"
}
```

## Usage

```typescript
import { formatFileSize, getFolderColor } from "@brainstrike/utils";

// Format file size for display
const size = formatFileSize(1024); // "1.0 KB"

// Get consistent folder color
const color = getFolderColor("my-folder");
console.log(color.light); // { bg: '#E6F3FF', text: '#0A558C' }
```

## Available Utilities

- **Color Utils**: Functions for generating and managing colors
- **File Utils**: File operations and format helpers
- **Token Utils**: Functions for measuring and estimating token counts

## Development

```bash
# Build the package
pnpm run build

# Run in watch mode during development
pnpm run dev

# Run tests
pnpm run test
```
