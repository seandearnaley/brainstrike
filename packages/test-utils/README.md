# @brainstrike/test-utils

Shared testing utilities, mocks, factories, and configuration for BrainStrike packages.

## Overview

This package provides testing infrastructure used across all BrainStrike packages:
- **Vitest configuration**: Base config and setup files
- **React Testing Library**: Utilities for component testing
- **Test factories**: Generate test data (file nodes, etc.)
- **Mock utilities**: Electron, Worker, and async mocks
- **Timeout helpers**: Manage test timeouts consistently

## Features

- **Base Vitest Config**: Shared test configuration
- **React Testing**: `renderWithProviders` for component tests
- **Electron Mocks**: Mock Electron APIs for testing
- **Worker Utilities**: Test Web Worker code
- **Async Helpers**: Promise and timeout utilities
- **Factories**: Generate realistic test data
- **Type-Safe**: Full TypeScript support

## Installation

```json
{
  "devDependencies": {
    "@brainstrike/test-utils": "workspace:*"
  }
}
```

## Usage

### Vitest Configuration

Extend the base Vitest configuration in your package:

**vitest.config.mts:**
```typescript
import { defineConfig, mergeConfig } from 'vitest/config';
import { vitestBaseConfig } from '@brainstrike/test-utils/vitest.base';

export default mergeConfig(
  vitestBaseConfig,
  defineConfig({
    test: {
      // Package-specific overrides
      environment: 'jsdom',
      setupFiles: ['@brainstrike/test-utils/vitest.setup']
    }
  })
);
```

### React Component Testing

```typescript
import { renderWithProviders } from '@brainstrike/test-utils';
import { screen } from '@testing-library/react';
import { MyComponent } from './my-component';

test('renders component with providers', () => {
  renderWithProviders(<MyComponent />);

  expect(screen.getByText('Hello')).toBeInTheDocument();
});
```

**With custom providers:**
```typescript
import { renderWithProviders } from '@brainstrike/test-utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient();

renderWithProviders(<MyComponent />, {
  wrapper: ({ children }) => (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  )
});
```

### Test Factories

Generate realistic test data:

```typescript
import { createFileNode, createFileTree } from '@brainstrike/test-utils';

test('processes file tree', () => {
  const tree = createFileTree({
    '/src': {
      'index.ts': 'export const x = 1;',
      'utils.ts': 'export const y = 2;',
      '__tests__': {
        'index.test.ts': 'test("works", () => {})'
      }
    }
  });

  expect(tree.children).toHaveLength(3);
});

test('creates single file node', () => {
  const file = createFileNode({
    name: 'test.ts',
    path: '/src/test.ts',
    isDirectory: false
  });

  expect(file.id).toBeDefined();
  expect(file.name).toBe('test.ts');
});
```

### Async Utilities

```typescript
import { waitFor, timeout, flushPromises } from '@brainstrike/test-utils';

test('waits for async operation', async () => {
  let result = false;

  setTimeout(() => { result = true; }, 100);

  await waitFor(() => expect(result).toBe(true));
});

test('handles timeouts', async () => {
  const promise = new Promise((resolve) => {
    setTimeout(resolve, 5000);
  });

  await expect(
    timeout(promise, 100)
  ).rejects.toThrow('Timeout');
});

test('flushes microtasks', async () => {
  let executed = false;
  Promise.resolve().then(() => { executed = true; });

  await flushPromises();

  expect(executed).toBe(true);
});
```

### Electron Mocks

```typescript
import { mockElectron } from '@brainstrike/test-utils';

test('mocks Electron APIs', () => {
  const electron = mockElectron({
    ipcRenderer: {
      send: vi.fn(),
      on: vi.fn()
    }
  });

  // Use mocked Electron API
  electron.ipcRenderer.send('test-channel', 'data');

  expect(electron.ipcRenderer.send).toHaveBeenCalledWith(
    'test-channel',
    'data'
  );
});
```

### Worker Testing

```typescript
import { createWorkerMock } from '@brainstrike/test-utils';

test('tests Web Worker', async () => {
  const worker = createWorkerMock({
    onMessage: (data) => {
      // Worker receives message
      expect(data.type).toBe('process');

      // Worker responds
      return { result: 'processed' };
    }
  });

  worker.postMessage({ type: 'process', data: 'test' });

  await waitFor(() => {
    expect(worker.onmessage).toHaveBeenCalled();
  });
});
```

## API

### Vitest Configuration

#### `vitestBaseConfig`

Base Vitest configuration object.

**Includes:**
- Happy DOM environment
- Test timeouts (10s default)
- Global test utilities
- Coverage configuration
- File patterns

**Usage:**
```typescript
import { vitestBaseConfig } from '@brainstrike/test-utils/vitest.base';
```

### React Testing

#### `renderWithProviders(ui, options?)`

Renders React components with common providers (React Query, Router, etc.).

**Parameters:**
- `ui`: React component to render
- `options?`: Render options (wrapper, etc.)

**Returns:** `RenderResult` from `@testing-library/react`

### Test Factories

#### `createFileNode(overrides?): IFileNode`

Creates a mock file node for testing.

**Example:**
```typescript
const file = createFileNode({
  name: 'example.ts',
  isDirectory: false,
  size: 1024
});
```

#### `createFileTree(structure): IFileNode`

Creates a nested file tree from a simple object structure.

**Example:**
```typescript
const tree = createFileTree({
  '/src': {
    'index.ts': 'content',
    'components': {
      'Button.tsx': 'component content'
    }
  }
});
```

### Async Utilities

#### `waitFor(condition, options?): Promise<void>`

Waits for a condition to become true.

**Parameters:**
- `condition`: Function that returns boolean or throws
- `options?`: `{ timeout?: number, interval?: number }`

#### `timeout(promise, ms): Promise<T>`

Wraps a promise with a timeout.

**Example:**
```typescript
await timeout(fetchData(), 3000); // Throws if > 3s
```

#### `flushPromises(): Promise<void>`

Flushes all pending promise microtasks.

### Electron Mocks

#### `mockElectron(overrides?)`

Creates a mock Electron object for testing.

**Provides mocks for:**
- `ipcRenderer`
- `app`
- `dialog`
- `shell`
- Custom overrides

### Worker Utilities

#### `createWorkerMock(options)`

Creates a mock Web Worker for testing.

**Options:**
- `onMessage`: Handler for worker messages
- Custom event handlers

## Shared Vitest Setup

The `vitest.setup.ts` file configures:
- `@testing-library/jest-dom` matchers
- Global test utilities
- Console mocking (optional)
- Performance monitoring

Import in your vitest config:

```typescript
{
  test: {
    setupFiles: ['@brainstrike/test-utils/vitest.setup']
  }
}
```

## Test Timeouts

The package provides standardized timeout constants:

```typescript
import { TIMEOUTS } from '@brainstrike/test-utils';

test('long operation', async () => {
  // ...
}, TIMEOUTS.SLOW); // 30s timeout

test('normal operation', async () => {
  // ...
}, TIMEOUTS.NORMAL); // 10s timeout
```

## Example Test Suite

```typescript
import { describe, it, expect } from 'vitest';
import {
  renderWithProviders,
  createFileNode,
  waitFor,
  flushPromises
} from '@brainstrike/test-utils';
import { FileList } from './file-list';

describe('FileList', () => {
  it('renders file nodes', () => {
    const files = [
      createFileNode({ name: 'file1.ts' }),
      createFileNode({ name: 'file2.ts' })
    ];

    const { getByText } = renderWithProviders(<FileList files={files} />);

    expect(getByText('file1.ts')).toBeInTheDocument();
    expect(getByText('file2.ts')).toBeInTheDocument();
  });

  it('handles async file loading', async () => {
    const { getByText } = renderWithProviders(<FileList />);

    await flushPromises();

    await waitFor(() => {
      expect(getByText('Loaded')).toBeInTheDocument();
    });
  });
});
```

## Package Exports

```json
{
  ".": "./dist/index.js",
  "./vitest.setup": "./src/vitest.setup.ts",
  "./vitest.base": "./vitest.base.mjs",
  "./electron": "./dist/index.js",
  "./worker": "./dist/index.js"
}
```

## Dependencies

- **@brainstrike/types**: Shared type definitions
- **@testing-library/react**: React component testing
- **@testing-library/jest-dom**: DOM matchers
- **vitest**: Test runner
- **jsdom**: DOM implementation for tests

## Development

```bash
# Build
pnpm build

# Watch mode
pnpm dev

# Run tests
pnpm test

# Type check
pnpm type-check

# Mutation testing
pnpm mutation
```

## Best Practices

1. **Use factories**: Generate test data with factories instead of inline objects
2. **Consistent timeouts**: Use the `TIMEOUTS` constants
3. **Flush promises**: Call `flushPromises()` when testing async code
4. **Mock Electron**: Always mock Electron APIs in unit tests
5. **Render with providers**: Use `renderWithProviders` for React components

## See Also

- [Vitest Documentation](https://vitest.dev/)
- [React Testing Library](https://testing-library.com/react)
- [@testing-library/jest-dom](https://github.com/testing-library/jest-dom)
