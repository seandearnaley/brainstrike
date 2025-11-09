# @brainstrike/platform-utils

Runtime platform detection utilities for BrainStrike applications.

## Overview

This lightweight package provides utilities to detect whether code is running in a web browser or Electron desktop environment. It enables conditional logic and adapter selection based on the runtime platform.

## Features

- **Lightweight**: Single-file, zero dependencies
- **Type-safe**: Full TypeScript support
- **Reliable**: Handles edge cases and detection errors gracefully
- **Cross-platform**: Works in browser, Node.js, and Electron environments

## Installation

```json
{
  "dependencies": {
    "@brainstrike/platform-utils": "workspace:*"
  }
}
```

## Usage

### Basic Platform Detection

```typescript
import { detectPlatform } from '@brainstrike/platform-utils';

const platform = detectPlatform();

if (platform === 'electron') {
  console.log('Running in Electron desktop app');
  // Use Node.js APIs, file system, etc.
} else {
  console.log('Running in web browser');
  // Use web APIs, IndexedDB, etc.
}
```

### Conditional Imports

```typescript
import { detectPlatform } from '@brainstrike/platform-utils';

let storage;

if (detectPlatform() === 'electron') {
  storage = await import('./electron-storage');
} else {
  storage = await import('./web-storage');
}
```

### Adapter Selection

```typescript
import { detectPlatform } from '@brainstrike/platform-utils';
import { ElectronAdapter, WebAdapter } from './adapters';

function createAdapter() {
  return detectPlatform() === 'electron'
    ? new ElectronAdapter()
    : new WebAdapter();
}

const adapter = createAdapter();
```

## API

### Types

```typescript
export type Platform = 'web' | 'electron';
```

### Functions

#### `detectPlatform(): Platform`

Detects the current runtime platform.

**Returns:**
- `'electron'` if running in Electron (main or renderer process)
- `'web'` if running in a web browser (or unknown environment)

**Detection Logic:**
1. Checks for Electron renderer process (`window.process.type === 'renderer'`)
2. Checks for Electron main process (`globalThis.process.versions.electron`)
3. Defaults to `'web'` if neither is detected

**Examples:**

```typescript
// In Electron renderer process
const platform = detectPlatform(); // 'electron'

// In browser
const platform = detectPlatform(); // 'web'

// In Node.js (non-Electron)
const platform = detectPlatform(); // 'web'
```

## Detection Methods

### Electron Renderer Process

Checks for `window.process.type === 'renderer'`:

```typescript
if (typeof window !== 'undefined') {
  const windowWithProcess = window as typeof window & {
    process?: { type?: string }
  };
  if (windowWithProcess.process?.type === 'renderer') {
    return 'electron';
  }
}
```

### Electron Main Process

Checks for `globalThis.process.versions.electron`:

```typescript
if (typeof globalThis !== 'undefined') {
  const globalWithProcess = globalThis as typeof globalThis & {
    process?: { versions?: { electron?: string } };
  };
  if (globalWithProcess.process?.versions?.electron) {
    return 'electron';
  }
}
```

### Default to Web

If neither Electron indicator is found, defaults to `'web'`:

```typescript
return 'web';
```

## Use Cases

### File System Adapters

```typescript
import { detectPlatform } from '@brainstrike/platform-utils';

function createFileSystemAdapter() {
  if (detectPlatform() === 'electron') {
    return new NodeFileSystemAdapter(); // Full fs access
  } else {
    return new WebFileSystemAdapter(); // File System Access API
  }
}
```

### Storage Adapters

```typescript
import { detectPlatform } from '@brainstrike/platform-utils';

function createStorageAdapter() {
  if (detectPlatform() === 'electron') {
    return new ElectronStoreAdapter(); // electron-store
  } else {
    return new LocalStorageAdapter(); // localStorage/IndexedDB
  }
}
```

### Feature Detection

```typescript
import { detectPlatform } from '@brainstrike/platform-utils';

const hasFileSystemAccess = detectPlatform() === 'electron' ||
  ('showDirectoryPicker' in window);

const canWatchFiles = detectPlatform() === 'electron';

const hasNativeMenus = detectPlatform() === 'electron';
```

## Integration Examples

### In @brainstrike/file-system

```typescript
import { detectPlatform } from '@brainstrike/platform-utils';
import { ElectronFileSystemAdapter, WebFileSystemAdapter } from './adapters';

export function createFileSystemAdapter() {
  return detectPlatform() === 'electron'
    ? new ElectronFileSystemAdapter()
    : new WebFileSystemAdapter();
}
```

### In @brainstrike/storage

```typescript
import { detectPlatform } from '@brainstrike/platform-utils';

export function createStorageAdapter() {
  return detectPlatform() === 'electron'
    ? createElectronStorage()
    : createWebStorage();
}
```

## Testing

The package handles detection errors gracefully:

```typescript
try {
  const platform = detectPlatform();
} catch {
  // Never throws - always returns 'web' or 'electron'
}
```

### Unit Tests

```typescript
import { detectPlatform } from '@brainstrike/platform-utils';
import { describe, it, expect, vi } from 'vitest';

describe('Platform detection', () => {
  it('detects Electron renderer process', () => {
    const mockWindow = {
      process: { type: 'renderer' }
    };
    globalThis.window = mockWindow as any;

    expect(detectPlatform()).toBe('electron');
  });

  it('defaults to web in browser', () => {
    expect(detectPlatform()).toBe('web');
  });
});
```

## Development

```bash
# Build
pnpm build

# Run tests
pnpm test

# Watch mode
pnpm test:watch

# Type check
pnpm type-check

# Development mode
pnpm dev
```

## Build Output

- **ESM**: `dist/index.js`
- **CJS**: `dist/index.cjs`
- **Types**: `dist/index.d.ts`

## Dependencies

None - this package has zero runtime dependencies.

## See Also

- [@brainstrike/file-system](../file-system/README.md) - Uses platform detection for adapter selection
- [@brainstrike/storage](../storage/README.md) - Uses platform detection for storage selection
- [Electron Documentation](https://www.electronjs.org/docs/latest/api/process)
- [Web Platform APIs](https://developer.mozilla.org/en-US/docs/Web/API)
