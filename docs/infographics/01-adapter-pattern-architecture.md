# Infographic Design Brief: Cross-Platform Adapter Pattern Architecture

## Context

BrainStrike is a context management tool for LLMs that runs as both a web application (Vite + React) and a desktop application (Electron). The system needs to work seamlessly across these two very different runtime environments while maintaining a single codebase for business logic.

## The Problem This Solves

**The Challenge**: How do you write file system and storage code once, but have it work in:
- **Web Browser**: Uses File System Access API (limited, permission-based, no file paths)
- **Electron/Desktop**: Uses Node.js APIs (full file system access, real paths)
- **Tests**: Needs in-memory implementations (no actual file system)

Traditional approaches would require littering the codebase with `if (isElectron)` checks everywhere, creating maintenance nightmares and tight coupling.

## The Solution: Adapter Pattern

BrainStrike implements the **Adapter Pattern** with two primary systems:

### 1. File System Adapter Architecture

**Core Interface** (`FileSystemAdapter`):
```typescript
interface FileSystemAdapter {
  requestDirectoryAccess(): Promise<DirectoryHandle>;
  readDirectory(handle: DirectoryHandle, options?: DirectoryReadOptions): Promise<IFileNode[]>;
  readFile(handle: FileHandle): Promise<string>;
  exists(path: string): Promise<boolean>;
  watchDirectory?(handle: DirectoryHandle, callback: (changes: FileSystemChange[]) => void): () => void;
}
```

**Three Implementations**:

#### A. Web Adapter (`WebFileSystemAdapter`)
- Uses browser File System Access API via `window.showDirectoryPicker()`
- **Limitation**: No real file paths (security restriction) - only uses directory name
- **Permission Model**: User explicitly grants access per session
- Reads files via `FileSystemFileHandle.getFile()` then `.text()`
- **File watching**: NOT SUPPORTED (browser limitation)
- **Size limit**: 1MB per file (prevents browser hangs)

Code snippet showing web-specific implementation:
```typescript
async requestDirectoryAccess(): Promise<DirectoryHandle> {
  if (!('showDirectoryPicker' in window)) {
    throw new Error('File System Access API not supported');
  }
  const dirHandle = await window.showDirectoryPicker();
  return {
    path: dirHandle.name, // ⚠️ NO FULL PATH - just the directory name
    name: dirHandle.name,
    kind: 'directory',
    platform: 'web',
    _internal: dirHandle, // Store the native handle
  };
}
```

#### B. Electron Adapter (`ElectronFileSystemAdapter`)
- Uses Node.js `fs/promises` API
- Opens directory picker via `electron.dialog.showOpenDialog()`
- **Full file paths**: `/Users/name/Documents/project`
- Reads files via `fsPromises.readFile(path, 'utf-8')`
- **File watching**: SUPPORTED via chokidar (with fallback to fs.watch)
- **Error handling**: Distinguishes between UserCancelled, Permission, Access, and Dialog errors

Code snippet showing Electron dialog integration:
```typescript
async requestDirectoryAccess(): Promise<DirectoryHandle> {
  const electron = await import('electron');
  const result = await electron.dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select a folder to explore',
  });

  if (result.canceled || result.filePaths.length === 0) {
    throw new UserCancelledError('User cancelled directory selection');
  }

  const selectedPath = result.filePaths[0]; // FULL PATH
  return {
    path: selectedPath,
    name: path.basename(selectedPath),
    kind: 'directory',
    platform: 'electron',
  };
}
```

Watcher implementation (complex):
```typescript
watchDirectory(
  handle: DirectoryHandle,
  callback: (changes: FileSystemChange[]) => void
): () => void {
  // Try chokidar first (better debouncing, cross-platform)
  // Gracefully fall back to fs.watch if unavailable
  // Returns disposer function that can be called anytime
}
```

#### C. Mock Adapter (`MockFileSystemAdapter`)
- In-memory implementation for tests
- Pre-configured directory structures
- No actual I/O operations
- Instant, deterministic responses

### 2. Storage Adapter Architecture

**Core Interface** (`StorageAdapter`):
```typescript
interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
  getAllKeys(): Promise<string[]>;
}
```

**Three Implementations**:

#### A. Web Storage Adapter
- Wraps `window.localStorage`
- Synchronous browser API wrapped in async interface
- ~5-10MB storage limit (browser-dependent)
```typescript
async getItem(key: string): Promise<string | null> {
  return this.storage.getItem(key); // localStorage is synchronous
}
```

#### B. Electron Storage Adapter
- File-based JSON persistence
- Stores in `app.getPath('userData')/electron-storage.json`
- In-memory cache + disk persistence
- **Safety check**: Never writes to CWD (prevents test pollution)
```typescript
private async persist() {
  if (!this.storePath) return; // Don't persist if path invalid
  await fsPromises.writeFile(
    this.storePath,
    JSON.stringify(this.cache, null, 2),
    'utf8'
  );
}
```

#### C. Memory Storage Adapter
- Pure in-memory `Map`
- For tests only
- No persistence

## The Factory Pattern

Runtime selection happens via factories:

**File System Factory** (`packages/file-system/src/factory.ts`):
```typescript
export function createFileSystemAdapter(platform: Platform): FileSystemAdapter {
  switch (platform) {
    case 'web':
      return new WebFileSystemAdapter();
    case 'electron':
      return new ElectronFileSystemAdapter();
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

export function createMockFileSystemAdapter(): FileSystemAdapter {
  return new MockFileSystemAdapter();
}

// Platform detection
export { detectPlatform }; // from @brainstrike/platform-utils
```

**Storage Factory** (similar pattern):
```typescript
export function createStorageAdapter(platform: Platform): StorageAdapter {
  switch (platform) {
    case 'web':
      return new WebStorageAdapter(window.localStorage);
    case 'electron':
      return new ElectronStorageAdapter();
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}
```

## Platform Detection

```typescript
// @brainstrike/platform-utils
export type Platform = 'web' | 'electron';

export function detectPlatform(): Platform {
  // Check for Electron renderer process
  if (typeof window !== 'undefined' && window.process?.type === 'renderer') {
    return 'electron';
  }
  // Check for Electron main process
  if (typeof process !== 'undefined' && process.versions?.electron) {
    return 'electron';
  }
  // Default to web
  return 'web';
}
```

## How It's Used in the Application

**In React Components**:
```typescript
// Application initialization
const platform = detectPlatform();
const fileSystemAdapter = createFileSystemAdapter(platform);
const storageAdapter = createStorageAdapter(platform);

// File explorer store uses adapter
const fileExplorerStore = useFileExplorerStore();
fileExplorerStore.setAdapter(fileSystemAdapter);

// Preferences store uses storage adapter
const preferencesStore = usePreferencesStore();
preferencesStore.setStorageAdapter(storageAdapter);
```

**Business Logic Stays Platform-Agnostic**:
```typescript
// This code works identically on web and desktop!
async function loadDirectory() {
  const handle = await adapter.requestDirectoryAccess();
  const files = await adapter.readDirectory(handle, { includeMetadata: true });
  const content = await adapter.readFile(files[0].handle);
  // Process content...
}
```

## Key Architectural Benefits

1. **Single Responsibility**: Each adapter handles ONE platform
2. **Open/Closed**: Easy to add new platforms (mobile?) without changing existing code
3. **Dependency Inversion**: Business logic depends on interfaces, not concrete implementations
4. **Testability**: Mock adapter makes testing trivial
5. **Type Safety**: TypeScript ensures all platforms implement the full interface

## Package Structure

```
packages/
├── file-system/
│   ├── src/
│   │   ├── types.ts              # FileSystemAdapter interface
│   │   ├── factory.ts            # createFileSystemAdapter()
│   │   ├── adapters/
│   │   │   ├── web-adapter.ts    # Browser implementation
│   │   │   ├── electron-adapter.ts   # Node.js implementation
│   │   │   └── mock-file-system-adapter.ts  # Test implementation
│   │   └── errors.ts             # Custom error types
│   └── package.json
├── storage/
│   ├── src/
│   │   ├── types.ts              # StorageAdapter interface
│   │   ├── factory.ts            # createStorageAdapter()
│   │   ├── adapters/
│   │   │   ├── web-storage-adapter.ts
│   │   │   ├── electron-storage-adapter.ts
│   │   │   └── memory-storage-adapter.ts
│   └── package.json
└── platform-utils/
    ├── src/
    │   └── detect-platform.ts    # Platform detection logic
    └── package.json
```

## Critical Implementation Details

### Concurrency Limiting
Both adapters use a concurrency limiter when reading file metadata to prevent overwhelming the system:

```typescript
const limiter = pLimit(50); // Max 50 concurrent file stat operations

const fileWorks = files.map((entry) =>
  limiter(async () => {
    const fullPath = path.join(handle.path, entry.name);
    return await fileNodeFromStat(handle, fullPath, entry.name);
  })
);
```

### Error Hierarchy
Custom error types maintain context:
- `AccessError`: File/directory access failed
- `PermissionError`: Permission denied
- `UserCancelledError`: User closed dialog
- `DialogError`: Dialog failed to open

### Handle Abstraction
`DirectoryHandle` and `FileHandle` types wrap platform-specific objects:
```typescript
interface DirectoryHandle {
  path: string;           // Full path (Electron) or name (Web)
  name: string;           // Directory name
  kind: 'directory';
  platform: 'web' | 'electron';
  _internal?: unknown;    // Native FileSystemDirectoryHandle or undefined
}
```

## Visual Suggestion for Infographic

**Recommended Layout**:
1. **Top Section**: Show the problem - messy code with platform checks scattered everywhere
2. **Middle Section**: Show the solution - clean interface with three adapter boxes
3. **Bottom Section**: Show the flow - how factory selects the right adapter at runtime
4. **Side Panel**: Benefits list with icons

**Key Visual Elements**:
- Three distinct "adapter boxes" (Web, Electron, Mock) all implementing same interface
- Factory as a "switch" or "router" selecting the right adapter
- Platform detection as a "detector" feeding into factory
- Business logic code shown as "clean" with no platform-specific branches
- Color coding: Blue for interface/contract, Green for Web, Purple for Electron, Gray for Mock

**Complexity to Emphasize**:
- The web adapter's constraint of no real file paths
- The Electron adapter's rich error handling
- The factory pattern's role in dependency injection
- How the same interface signature works completely differently under the hood

## Technical Depth Notes

- **Web**: FileSystemFileHandle vs FileSystemDirectoryHandle browser APIs
- **Electron**: Node.js fs.promises vs Electron dialog integration
- **Chokidar**: File watching library with debouncing and cross-platform support
- **pLimit**: Concurrency control to prevent resource exhaustion
- **TypeScript**: Interface-based design enforces contract compliance

This pattern is the foundation that enables BrainStrike to maintain a single codebase while running in fundamentally different JavaScript runtime environments.
