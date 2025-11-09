# @brainstrike/storage

Platform-agnostic persistent storage abstraction with adapters for web (localStorage), desktop (electron-store), and testing (in-memory) environments.

## Overview

This package provides a unified key-value storage API that works across different platforms:
- **Web**: Uses `localStorage` for browser environments
- **Electron**: Uses `electron-store` for desktop applications
- **Memory**: In-memory storage for testing

By abstracting platform differences, application code can use a consistent storage interface regardless of the runtime environment.

## Features

- **Adapter Pattern**: Pluggable storage implementations
- **Unified API**: Consistent interface across all platforms
- **Type Safety**: Full TypeScript support with generic types
- **Automatic Selection**: Factory function detects platform
- **Testing Support**: In-memory adapter for unit tests

## Installation

```json
{
  "dependencies": {
    "@brainstrike/storage": "workspace:*"
  }
}
```

## Usage

### Factory Pattern (Recommended)

```typescript
import { createStorageAdapter } from '@brainstrike/storage';

// Automatically detects platform and returns appropriate adapter
const storage = createStorageAdapter();

// Use unified API
await storage.set('user', { name: 'Alice', id: 123 });
const user = await storage.get('user'); // { name: 'Alice', id: 123 }
await storage.remove('user');
await storage.clear();
```

### Explicit Adapter Selection

#### Web Adapter (localStorage)

```typescript
import { WebStorageAdapter } from '@brainstrike/storage';

const storage = new WebStorageAdapter();

// Stores data in localStorage
await storage.set('theme', 'dark');
const theme = await storage.get('theme'); // 'dark'
```

#### Electron Adapter

```typescript
import { ElectronStorageAdapter } from '@brainstrike/storage';

const storage = new ElectronStorageAdapter({
  name: 'my-app',
  defaults: {
    theme: 'light',
    language: 'en'
  }
});

// Stores data in ~/.config/my-app/config.json (Linux)
// or ~/Library/Application Support/my-app/config.json (macOS)
await storage.set('windowBounds', { width: 800, height: 600 });
```

#### Memory Adapter (Testing)

```typescript
import { MemoryStorageAdapter } from '@brainstrike/storage';

const storage = new MemoryStorageAdapter();

// Stores data in-memory (no disk persistence)
await storage.set('testData', { foo: 'bar' });
const data = await storage.get('testData'); // { foo: 'bar' }
```

## API

### Common Interface

All adapters implement the `StorageAdapter` interface:

```typescript
interface StorageAdapter {
  // Core operations
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;

  // Utility
  has(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
}
```

### Methods

#### `get<T>(key: string): Promise<T | undefined>`

Retrieve a value by key.

```typescript
const user = await storage.get<{ name: string }>('user');
if (user) {
  console.log(user.name);
}
```

#### `set<T>(key: string, value: T): Promise<void>`

Store a value with the given key.

```typescript
await storage.set('preferences', {
  theme: 'dark',
  fontSize: 14
});
```

#### `remove(key: string): Promise<void>`

Delete a key-value pair.

```typescript
await storage.remove('temporary-data');
```

#### `clear(): Promise<void>`

Remove all stored data.

```typescript
await storage.clear();
```

#### `has(key: string): Promise<boolean>`

Check if a key exists.

```typescript
if (await storage.has('user')) {
  console.log('User data exists');
}
```

#### `keys(): Promise<string[]>`

Get all storage keys.

```typescript
const allKeys = await storage.keys();
console.log('Stored keys:', allKeys);
```

## Adapters

### Web Adapter (localStorage)

**Platform**: Browser environments

**Features:**
- Uses `window.localStorage` API
- Synchronous underlying API, wrapped in async interface
- Data persists across sessions
- JSON serialization/deserialization

**Limitations:**
- 5-10 MB storage limit (browser-dependent)
- Synchronous blocking I/O (mitigated by async wrapper)
- String-only storage (handled via JSON)

**Usage:**
```typescript
const storage = new WebStorageAdapter();
await storage.set('token', 'abc123');
```

### Electron Adapter (electron-store)

**Platform**: Electron desktop applications

**Features:**
- Uses `electron-store` package
- Persistent file-based storage
- Atomic writes (no corruption)
- Cross-platform paths
- Supports defaults

**Usage:**
```typescript
const storage = new ElectronStorageAdapter({
  name: 'brainstrike',
  defaults: {
    windowWidth: 1024,
    windowHeight: 768
  }
});

await storage.set('lastOpenedFile', '/path/to/file.txt');
```

**Storage Locations:**
- **Linux**: `~/.config/<app-name>/config.json`
- **macOS**: `~/Library/Application Support/<app-name>/config.json`
- **Windows**: `%APPDATA%\<app-name>\config.json`

### Memory Adapter

**Platform**: Testing and development

**Features:**
- In-memory Map storage
- No disk I/O
- Fast and deterministic
- Data cleared on restart

**Usage:**
```typescript
const storage = new MemoryStorageAdapter();

// Use in tests
await storage.set('test-key', 'test-value');
expect(await storage.get('test-key')).toBe('test-value');
```

## Factory Function

### `createStorageAdapter(options?)`

Automatically detects the runtime environment and returns the appropriate adapter.

**Detection logic:**
1. Checks for Electron environment → returns `ElectronStorageAdapter`
2. Checks for browser environment → returns `WebStorageAdapter`
3. Defaults to `MemoryStorageAdapter` (for testing/Node.js)

**Usage:**
```typescript
import { createStorageAdapter } from '@brainstrike/storage';

// Automatic platform detection
const storage = createStorageAdapter();

// Optional: Pass adapter-specific options
const electronStorage = createStorageAdapter({
  name: 'my-app',
  defaults: { theme: 'dark' }
});
```

## Type Safety

The storage API supports TypeScript generics for type-safe operations:

```typescript
interface UserPreferences {
  theme: 'light' | 'dark';
  fontSize: number;
  language: string;
}

const storage = createStorageAdapter();

// Type-safe set
await storage.set<UserPreferences>('prefs', {
  theme: 'dark',
  fontSize: 14,
  language: 'en'
});

// Type-safe get
const prefs = await storage.get<UserPreferences>('prefs');
if (prefs) {
  console.log(prefs.theme); // TypeScript knows this is 'light' | 'dark'
}
```

## Common Patterns

### Configuration Management

```typescript
const storage = createStorageAdapter();

async function loadConfig() {
  const config = await storage.get('config');
  return config ?? DEFAULT_CONFIG;
}

async function saveConfig(config: AppConfig) {
  await storage.set('config', config);
}
```

### Cache Management

```typescript
async function getCachedData(key: string, fetchFn: () => Promise<Data>) {
  // Try cache first
  const cached = await storage.get(key);
  if (cached) return cached;

  // Fetch and cache
  const fresh = await fetchFn();
  await storage.set(key, fresh);
  return fresh;
}
```

### Session Management

```typescript
async function saveSession(user: User) {
  await storage.set('session', {
    userId: user.id,
    token: user.token,
    expiry: Date.now() + 3600000 // 1 hour
  });
}

async function loadSession() {
  const session = await storage.get('session');
  if (!session || session.expiry < Date.now()) {
    await storage.remove('session');
    return null;
  }
  return session;
}
```

## Testing

### Unit Tests

```typescript
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { describe, it, expect } from 'vitest';

describe('Storage operations', () => {
  it('stores and retrieves data', async () => {
    const storage = new MemoryStorageAdapter();

    await storage.set('key', 'value');
    const result = await storage.get('key');

    expect(result).toBe('value');
  });

  it('removes data', async () => {
    const storage = new MemoryStorageAdapter();

    await storage.set('key', 'value');
    await storage.remove('key');

    expect(await storage.has('key')).toBe(false);
  });
});
```

### Integration Tests

```typescript
// Test with actual platform adapter
const storage = createStorageAdapter();

await storage.set('test', 'data');
const result = await storage.get('test');
expect(result).toBe('data');

// Clean up
await storage.remove('test');
```

## Dependencies

- **@brainstrike/platform-utils**: Platform detection

### Peer Dependencies

- **electron-store** (optional): Required for `ElectronStorageAdapter`

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

# Dev mode
pnpm dev
```

## Migration Guide

### From localStorage to Storage Adapter

**Before:**
```typescript
const user = JSON.parse(localStorage.getItem('user') || '{}');
localStorage.setItem('user', JSON.stringify(user));
```

**After:**
```typescript
const storage = createStorageAdapter();
const user = await storage.get('user') ?? {};
await storage.set('user', user);
```

### From electron-store to Storage Adapter

**Before:**
```typescript
import Store from 'electron-store';
const store = new Store();
const config = store.get('config');
store.set('config', newConfig);
```

**After:**
```typescript
import { createStorageAdapter } from '@brainstrike/storage';
const storage = createStorageAdapter();
const config = await storage.get('config');
await storage.set('config', newConfig);
```

## See Also

- [@brainstrike/platform-utils](../platform-utils/README.md) - Platform detection
- [@brainstrike/file-system](../file-system/README.md) - File system adapter pattern
- [Web Storage API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API)
- [electron-store](https://github.com/sindresorhus/electron-store)
