# Jest to Vitest Migration Guide

This document outlines the configuration and usage of Vitest for testing in this Vite-based project, covering the setup performed during the migration from Jest.

## Why Migrate to Vitest?

- Vitest is designed to work with Vite and provides a faster test execution
- It has a very similar API to Jest, making migration straightforward
- It supports TypeScript natively without extra configuration
- It works well with ESM modules used in the Vite ecosystem

## Migration Steps

### 1. Install Required Dependencies

```bash
npm install --save-dev vitest jsdom @vitest/ui @vitest/coverage-v8
```

### 2. Create Vitest Configuration

Create a `vitest.config.ts` file in the project root:

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'src/**/*.integration.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'src/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'src/**/*.d.ts',
        'src/**/*.stories.{js,jsx,ts,tsx}',
        'src/mocks/**/*',
        'src/e2e/**/*',
      ],
      thresholds: {
        branches: 0.5,
        functions: 0.5,
        lines: 0.5,
        statements: 0.5,
      },
    },
    mockReset: true,
  },
});
```

### 3. Create Vitest Setup File

Create `src/test/vitest.setup.ts`:

```typescript
import '@testing-library/jest-dom';
import { resetStore } from './test-utils';
import { configure } from '@testing-library/react';
import { TextEncoder, TextDecoder } from 'node:util';
import { vi, beforeEach } from 'vitest';

// Configure React 18 test environment
configure({
  reactStrictMode: true,
  asyncUtilTimeout: 1000,
  computedStyleSupportsPseudoElements: true,
});

// Mock the Zustand store
vi.mock('../stores/use-file-explorer-store');

// Reset store before each test
beforeEach(() => {
  resetStore();
});

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock IntersectionObserver
class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  value: MockIntersectionObserver,
});

// Mock ResizeObserver
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  value: MockResizeObserver,
});

// Add TextEncoder/TextDecoder to global
global.TextEncoder = TextEncoder;
(global as any).TextDecoder = TextDecoder;

// Configure console to handle test output better
const originalError = console.error;
console.error = (...args) => {
  // List of expected error messages to filter
  const expectedErrors = [
    'Not implemented: window.computedStyle',
    'The current testing environment is not configured to support act',
    'inside a test was not wrapped in act',
    'Error: Access denied', // File access errors in tests
    'Error processing fail', // Expected file processing errors
    'PartialRefreshError', // Expected partial refresh errors
    'Error loading file tree', // Expected file tree loading errors
    'Error getting file handle', // Expected file handle errors
    'Failed to load file', // Expected file loading errors
    'Failed to refresh file tree', // Expected file tree refresh errors
  ];

  // Check if any of the arguments contain expected error messages
  if (args.some(arg => {
    const str = arg?.toString() || '';
    return expectedErrors.some(expected => str.includes(expected)) ||
           arg?.stack?.includes('Not implemented: window.computedStyle');
  })) {
    return;
  }

  originalError.call(console, ...args);
};
```

### 4. Update the Test Utils

Update `src/test/test-utils.ts` to work with Vitest:

```typescript
import { useFileExplorerStore } from '@/stores/__mocks__/use-file-explorer-store';

export const resetStore = () => {
  const store = useFileExplorerStore.getState();
  const mockFns = [
    'setSelectedFiles',
    'addSelectedFile',
    'removeSelectedFile',
    'clearSelectedFiles',
    'setExpandedPaths',
    'toggleDirectoryExpansion',
    'setFilters',
    'setUseRegex',
    'setIncludeProjectTree',
    'setFolderSummaryThreshold',
  ] as const;

  for (const fn of mockFns) {
    if (store[fn] && typeof store[fn] === 'function' && 'mockClear' in store[fn]) {
      (store[fn] as { mockClear: () => void }).mockClear();
    }
  }

  useFileExplorerStore.setState({
    selectedFilePaths: new Set<string>(),
    expandedDirectoryPaths: new Set<string>(),
    includeFilters: [],
    excludeFilters: [],
    useRegex: false,
    includeProjectTree: true,
    folderSummaryThreshold: 100,
  });
};
```

### 5. Update Mocks

Update any mock files to use Vitest's mocking functions:

Example `src/stores/__mocks__/use-file-explorer-store.ts`:

```typescript
import type { IFileNode } from '@/lib/file/types';
import { create } from 'zustand';
import { vi } from 'vitest';

interface FileExplorerState {
  // ... state properties

  // Use simpler type definitions for mocks
  setSelectedFiles: any;
  addSelectedFile: any;
  // ... other mock functions
}

const mockStore = create<FileExplorerState>((set, get) => ({
  // ... state
  
  // Replace jest.fn with vi.fn
  setSelectedFiles: vi.fn((files: ReadonlySet<string>) => {
    set({ selectedFilePaths: new Set(files) });
  }),
  
  // ... other mock functions
}));

export const useFileExplorerStore = mockStore;
```

### 6. Update Test Files

Update the test files to use Vitest instead of Jest:

1. Import from Vitest instead of Jest
2. Replace Jest timer functions with Vitest equivalents
3. Keep the test logic mostly the same

Example:
```typescript
// Before
import { act, renderHook } from '@testing-library/react';
import { useDebouncedValue } from '../use-debounced-value';

describe('useDebouncedValue', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('should debounce value updates', () => {
    // ...
    act(() => {
      jest.advanceTimersByTime(300);
    });
    // ...
  });
});

// After
import { act, renderHook } from '@testing-library/react';
import { useDebouncedValue } from '../use-debounced-value';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('should debounce value updates', () => {
    // ...
    act(() => {
      vi.advanceTimersByTime(300);
    });
    // ...
  });
});
```

### 7. Add Scripts to package.json

```json
{
  "scripts": {
    "vitest": "vitest run",
    "vitest:watch": "vitest",
    "vitest:ui": "vitest --ui",
    "vitest:coverage": "vitest run --coverage",
    "vitest:unit": "vitest run \"src/**/*.test.{ts,tsx}\"",
    "vitest:integration": "vitest run \"src/**/*.integration.test.{ts,tsx}\""
  }
}
```

## Common Jest to Vitest Replacements

| Jest                     | Vitest                   |
|--------------------------|--------------------------|
| `jest.fn()`              | `vi.fn()`                |
| `jest.mock()`            | `vi.mock()`              |
| `jest.spyOn()`           | `vi.spyOn()`             |
| `jest.useFakeTimers()`   | `vi.useFakeTimers()`     |
| `jest.useRealTimers()`   | `vi.useRealTimers()`     |
| `jest.advanceTimersByTime()` | `vi.advanceTimersByTime()` |
| `jest.runOnlyPendingTimers()` | `vi.runOnlyPendingTimers()` |
| `jest.resetAllMocks()`   | `vi.resetAllMocks()`     |
| `jest.clearAllMocks()`   | `vi.clearAllMocks()`     |

## Migration Strategy

1. Start with a single simple test file and ensure it works
2. Gradually migrate test files one by one
3. Update shared mocks and utilities as needed
4. Once all tests are migrated, remove Jest dependencies

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [Vitest API Reference](https://vitest.dev/api/)
- [Migrating from Jest](https://vitest.dev/guide/migration.html) 