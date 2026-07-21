# @brainstrike/build-utils

Build-time utilities and Vite plugins for BrainStrike applications.

## Overview

This package provides shared build utilities and Vite plugins used across BrainStrike web and desktop applications. It handles platform-specific build concerns and optimizes the development experience.

## Features

### PGlite WASM Path Resolution
Automatically locates the PGlite WebAssembly file in pnpm workspace environments, handling both flat and nested node_modules structures.

### Vite HMR Optimization
Smart Hot Module Replacement (HMR) plugin that triggers full page reloads for compiler-sensitive files, preventing React Fast Refresh errors.

## Installation

This is an internal workspace package. Add it to your package.json:

```json
{
  "dependencies": {
    "@brainstrike/build-utils": "workspace:*"
  }
}
```

## Usage

### Finding PGlite WASM

```typescript
import { findPGliteWasm } from '@brainstrike/build-utils';

const wasmPath = findPGliteWasm(__dirname);
if (!wasmPath) {
  console.error('PGlite WASM not found');
}
```

### Vite Plugin: Full Reload on Compiler Hotspots

Add to your `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import { fullReloadOnCompilerHotspots } from '@brainstrike/build-utils';

export default defineConfig({
  plugins: [
    fullReloadOnCompilerHotspots(),
    // ... other plugins
  ],
});
```

This plugin automatically triggers full page reloads when files matching compiler hotspot patterns are modified, ensuring React state consistency during development.

## API

### `findPGliteWasm(baseDir: string): string | null`

Searches for the PGlite WASM file in common locations:
- Direct node_modules
- Workspace root node_modules
- pnpm virtual store (.pnpm directory)

**Parameters:**
- `baseDir`: Base directory to start search from (typically `__dirname`)

**Returns:**
- Absolute path to `pglite.wasm` if found
- `null` if not found

**Example:**
```typescript
const wasmPath = findPGliteWasm(__dirname);
```

### `fullReloadOnCompilerHotspots(): Plugin`

Vite plugin that forces full page reload for files that may cause HMR issues.

**Returns:** Vite plugin object

**Behavior:**
- Monitors file changes during HMR
- Detects "compiler hotspots" (files that require full reload)
- Invalidates each affected module and its importer graph before suppressing normal HMR
- Sends full-reload signal to Vite dev server
- Prevents a reload from reusing stale transformed import URLs and splitting React context identity

## Dependencies

- **vite**: Vite plugin API types

## Development

```bash
# Build
pnpm build

# Run tests
pnpm test

# Type check
pnpm type-check

# Clean build artifacts
pnpm clean
```

## Build Output

- **ESM**: `dist/index.mjs`
- **CJS**: `dist/index.js`
- **Types**: `dist/index.d.ts`

## Technical Notes

### PGlite WASM Resolution

The `findPGliteWasm` function handles pnpm's unique node_modules structure:
1. Checks direct dependencies first
2. Falls back to workspace root
3. Scans pnpm virtual store (`.pnpm/@electric-sql+pglite@*`)
4. Returns first valid path found

This ensures PGlite works correctly in monorepo setups with hoisted or isolated dependencies.

### Compiler Hotspot Detection

Some files cannot be hot-reloaded safely due to:
- React context providers
- Store initialization
- Module-level side effects
- Type-only changes that affect runtime

The HMR plugin detects these patterns with the build-local `isCompilerHotspot` helper and forces full reloads to prevent development errors.

## See Also

- [Vite Plugin API](https://vitejs.dev/guide/api-plugin.html)
- [PGlite Documentation](https://pglite.dev/)
