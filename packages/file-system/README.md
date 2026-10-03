# @brainstrike/file-system

Platform-agnostic file system abstraction layer with adapters for web, desktop (Electron), and testing environments.

`@brainstrike/file-system/directory-tree` is the shared browser-safe traversal
entry. It exports the existing `readFullTree`, `readFullTreeWithOptions`,
`walkDirectoryParallel`, their option types and `DirectoryListingTruncatedError`.
Its `DirectoryReadCapability` requires only `readDirectory`; Node owners do not
need browser or dialog stubs. Existing UI entry points re-export this authority.
Cancellation and read-error rejection join every admitted directory read.
Traversal filters, path/handle identity, sorting, truncation and streaming options
retain their existing behavior. Indexing callers explicitly enable strict child
read errors and report truncated listings.

## Overview

This package provides a unified file system API that works across different platforms:
- **Web**: Uses File System Access API for browser environments
- **Electron**: Uses Node.js `fs` module for desktop applications
- **Mock**: In-memory file system for testing

By abstracting platform differences, business logic can remain platform-agnostic while file operations adapt to the runtime environment.

## Features

- **Adapter Pattern**: Pluggable file system implementations
- **Unified API**: Consistent interface across all platforms
- **Type Safety**: Full TypeScript support with shared types
- **File Watching**: Optional file change monitoring (Electron)
- **Error Handling**: Platform-specific error normalization
- **Testing Support**: Mock adapter for unit tests

## Installation

```json
{
  "dependencies": {
    "@brainstrike/file-system": "workspace:*"
  }
}
```

## Usage

### Factory Pattern (Recommended)

```typescript
import { createFileSystemAdapter } from '@brainstrike/file-system';

// Automatically detects platform and returns appropriate adapter
const fileSystem = createFileSystemAdapter();

// Use unified API
const files = await fileSystem.readDirectory('/path/to/dir');
const content = await fileSystem.readFile('/path/to/file.txt');
```

### Explicit Adapter Selection

#### Web Adapter

```typescript
import { WebFileSystemAdapter } from '@brainstrike/file-system';

const fileSystem = new WebFileSystemAdapter();

// Request directory access (triggers browser permission prompt)
const dirHandle = await window.showDirectoryPicker();
await fileSystem.initialize(dirHandle);

// Read files
const files = await fileSystem.readDirectory();
```

#### Electron Adapter

```typescript
import { ElectronFileSystemAdapter } from '@brainstrike/file-system';

const fileSystem = new ElectronFileSystemAdapter('/base/path');

// Direct file system access (no initialization needed)
const files = await fileSystem.readDirectory('/subdirectory');
const content = await fileSystem.readFile('/file.txt');

// Watch for changes (optional - requires chokidar)
const watcher = fileSystem.watch('/path', {
  ignored: /node_modules/,
  persistent: true
});

watcher.on('change', (path) => {
  console.log(`File changed: ${path}`);
});
```

#### Mock Adapter (Testing)

```typescript
import { MockFileSystemAdapter } from '@brainstrike/file-system';

const fileSystem = new MockFileSystemAdapter({
  files: {
    '/project/src/index.ts': 'console.log("Hello");',
    '/project/README.md': '# My Project',
    '/project/package.json': '{"name": "test"}'
  }
});

// Works like real adapter
const content = await fileSystem.readFile('/project/src/index.ts');
expect(content).toBe('console.log("Hello");');
```

## API

### Common Interface

All adapters implement the `FileSystemAdapter` interface:

```typescript
interface FileSystemAdapter {
  // Read operations
  readDirectory(path?: string): Promise<IFileNode[]>;
  readFile(path: string): Promise<string>;

  // File metadata
  exists(path: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;

  // Optional features
  watch?(path: string, options?: WatchOptions): FileWatcher | undefined;

  // Lifecycle
  dispose(): void;
}
```

### File Node Structure

```typescript
interface IFileNode {
  id: string;           // Unique identifier
  name: string;         // File/directory name
  path: string;         // Full path
  isDirectory: boolean; // Directory flag
  children?: IFileNode[]; // Nested children (for directories)
  size?: number;        // File size in bytes
  modifiedTime?: Date;  // Last modified timestamp
}
```

## Path validation (Node-only)

For Electron main process and other Node.js consumers, the package exposes a shared path
validation helper that normalizes requested paths, enforces root boundaries, and applies
security guards (null bytes, traversal caps, sensitive Unix directories).

```typescript
import { resolveValidatedPath } from '@brainstrike/file-system/path-validation';

const result = await resolveValidatedPath({
  rootDir: '/Users/alice/projects',
  requestedPath: '../notes.md',
});

if (!result.ok) {
  throw new Error(result.error.message);
}

console.log('Resolved path:', result.path);
```

Note: This helper imports Node.js `fs` and `path` modules, so it should not be used in
browser or renderer processes. Use it from Electron main process or other Node contexts.

## Adapters

### Web Adapter

**Platform**: Browser with File System Access API support

**Features:**
- Uses modern browser APIs (`FileSystemDirectoryHandle`)
- Requires user permission for directory access
- Sandboxed to user-selected directories
- No file watching support

**Limitations:**
- Requires HTTPS or localhost
- Limited browser support (Chrome/Edge 86+, Safari 15.2+)
- User must grant directory access each session

**Usage:**
```typescript
const adapter = new WebFileSystemAdapter();

// Prompt user to select directory
const dirHandle = await window.showDirectoryPicker();
await adapter.initialize(dirHandle);
```

### Electron Adapter

**Platform**: Electron/Node.js desktop applications

**Features:**
- Full file system access
- File watching via chokidar (optional dependency)
- Recursive directory reading
- Symlink support

**Usage:**
```typescript
const adapter = new ElectronFileSystemAdapter('/home/user/projects');

// Optional: Enable file watching
const watcher = adapter.watch('/home/user/projects', {
  ignored: /(^|[\/\\])\../, // Ignore dotfiles
  persistent: true,
  ignoreInitial: true
});

watcher?.on('add', (path) => console.log('File added:', path));
watcher?.on('change', (path) => console.log('File changed:', path));
watcher?.on('unlink', (path) => console.log('File removed:', path));
```

### Mock Adapter

**Platform**: Testing environments

**Features:**
- In-memory file system
- No actual disk I/O
- Fast and deterministic
- Pre-populate with test fixtures

**Usage:**
```typescript
const adapter = new MockFileSystemAdapter({
  files: {
    '/test/file1.ts': 'export const x = 1;',
    '/test/file2.ts': 'export const y = 2;',
    '/test/nested/file3.ts': 'export const z = 3;'
  }
});

// Use in tests
const files = await adapter.readDirectory('/test');
expect(files).toHaveLength(3);
```

## Factory Function

### `createFileSystemAdapter()`

Automatically detects the runtime environment and returns the appropriate adapter.

**Detection logic:**
1. Checks for Electron environment → returns `ElectronFileSystemAdapter`
2. Checks for browser environment → returns `WebFileSystemAdapter`
3. Defaults to `MockFileSystemAdapter` (for testing)

**Usage:**
```typescript
import { createFileSystemAdapter } from '@brainstrike/file-system';

const fileSystem = createFileSystemAdapter();

// Adapter type is automatically selected based on environment
if (fileSystem instanceof ElectronFileSystemAdapter) {
  console.log('Running in Electron');
} else if (fileSystem instanceof WebFileSystemAdapter) {
  console.log('Running in browser');
}
```

## Error Handling

All adapters throw consistent error types:

```typescript
import { FileSystemError, ErrorCode } from '@brainstrike/file-system';

try {
  const content = await fileSystem.readFile('/nonexistent.txt');
} catch (error) {
  if (error instanceof FileSystemError) {
    switch (error.code) {
      case ErrorCode.NOT_FOUND:
        console.error('File not found');
        break;
      case ErrorCode.PERMISSION_DENIED:
        console.error('Permission denied');
        break;
      case ErrorCode.INVALID_PATH:
        console.error('Invalid path');
        break;
    }
  }
}
```

## Testing

### Unit Tests

```typescript
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { describe, it, expect } from 'vitest';

describe('File operations', () => {
  it('reads file content', async () => {
    const fs = new MockFileSystemAdapter({
      files: {
        '/test.txt': 'Hello, World!'
      }
    });

    const content = await fs.readFile('/test.txt');
    expect(content).toBe('Hello, World!');
  });
});
```

### Integration Tests

```typescript
// Test with actual file system adapter
const fs = createFileSystemAdapter();

// Tests will use real adapter in Electron, web adapter in browser
const files = await fs.readDirectory('/real/path');
```

## Dependencies

- **@brainstrike/types**: Shared TypeScript types (`IFileNode`)
- **@brainstrike/platform-utils**: Platform detection utilities
- **chokidar** (optional): File watching for Electron adapter

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

# Mutation testing
pnpm mutation
```

## Platform Detection

The package uses `@brainstrike/platform-utils` for runtime detection:

```typescript
import { isElectron, isBrowser } from '@brainstrike/platform-utils';

if (isElectron()) {
  // Use Electron adapter
} else if (isBrowser()) {
  // Use Web adapter
} else {
  // Use Mock adapter (tests)
}
```

## See Also

- [@brainstrike/types](../types/README.md) - Shared type definitions
- [@brainstrike/platform-utils](../platform-utils/README.md) - Platform detection
- [@brainstrike/storage](../storage/README.md) - Storage adapter pattern
- [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API)
