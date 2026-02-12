---
title: Testing Standards
sidebar_position: 2
---

# Testing Standards for BrainStrike Monorepo

This document outlines the standardized testing practices, organization patterns, and mocking strategies used across all packages in the BrainStrike monorepo.

## Overview

The BrainStrike monorepo uses a comprehensive testing strategy with multiple testing frameworks:

- **Vitest** for unit and integration tests
- **React Testing Library (RTL)** for React component testing
- **Playwright** for end-to-end testing
- **Stryker** for mutation testing (where configured)

## Test Organization Standards

### File Naming Conventions

All test files follow consistent naming patterns:

```
src/
├── components/
│   ├── Button.tsx
│   └── Button.test.tsx          # Unit tests
├── utils/
│   ├── helpers.ts
│   └── helpers.test.ts          # Unit tests
├── hooks/
│   ├── use-data.ts
│   └── use-data.test.ts         # Unit tests
└── __tests__/
    ├── integration/             # Integration tests
    │   └── api-integration.test.ts
    └── e2e/                     # E2E test utilities
        └── test-helpers.ts
```

### Test Categories

#### Unit Tests (`.test.ts`)
- **Purpose**: Test individual functions, components, or classes in isolation
- **Location**: Co-located with source files
- **Scope**: Single unit of functionality
- **Mocking**: Mock external dependencies

#### Integration Tests (`.integration.test.ts`)
- **Purpose**: Test interactions between multiple units
- **Location**: `__tests__/integration/` directory
- **Scope**: Cross-unit functionality
- **Mocking**: Minimal mocking, focus on real interactions

#### E2E Tests (`.e2e.test.ts`)
- **Purpose**: Test complete user workflows
- **Location**: `apps/*/e2e/` directory
- **Scope**: Full application flows
- **Mocking**: No mocking, use real services

## Mocking Strategies

### React Component Mocking

#### Mock External Dependencies
```typescript
// Mock heavy dependencies
vi.mock('@brainstrike/embeddings', () => ({
  SimpleEmbeddingService: vi.fn().mockImplementation(() => ({
    initializeWithModel: vi.fn().mockResolvedValue(undefined),
    generateDocEmbedding: vi.fn().mockResolvedValue({
      embedding: [0.1, 0.2, 0.3],
      dimensions: 3
    }),
    dispose: vi.fn().mockResolvedValue(undefined)
  }))
}));

// Mock Electron APIs
vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  }
}));
```

#### Mock Browser APIs
```typescript
// Mock localStorage
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn()
  }
});

// Mock File System Access API
Object.defineProperty(window, 'showOpenFilePicker', {
  value: vi.fn().mockResolvedValue([{
    getFile: vi.fn().mockResolvedValue(new File(['content'], 'test.txt'))
  }])
});
```

### Zustand Store Mocking

#### Mock Store Factories
```typescript
// Mock store creation
vi.mock('@brainstrike/file-explorer', () => ({
  createFileExplorerStore: vi.fn().mockReturnValue({
    getState: vi.fn(),
    setState: vi.fn(),
    subscribe: vi.fn(),
    destroy: vi.fn()
  })
}));
```

#### Mock Store State
```typescript
// Create mock store state
const mockStoreState = {
  files: [],
  selectedFiles: new Set(),
  expandedFolders: new Set(),
  isLoading: false
};

// Use in tests
const { result } = renderHook(() => useFileExplorerStore(), {
  wrapper: ({ children }) => (
    <FileExplorerProvider store={mockStore}>
      {children}
    </FileExplorerProvider>
  )
});
```

### API Mocking

#### Mock Fetch Requests
```typescript
// Mock fetch globally
global.fetch = vi.fn();

// Mock specific endpoints
beforeEach(() => {
  vi.mocked(fetch).mockImplementation((url) => {
    if (url.includes('/api/files')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ files: mockFiles })
      });
    }
    return Promise.reject(new Error('Unknown endpoint'));
  });
});
```

#### Mock WebSocket Connections
```typescript
// Mock WebSocket
class MockWebSocket {
  constructor(url: string) {
    setTimeout(() => this.onopen?.(new Event('open')), 0);
  }
  
  send = vi.fn();
  close = vi.fn();
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
}

global.WebSocket = MockWebSocket as any;
```

## Testing Patterns

### React Component Testing

#### Basic Component Test
```typescript
import { render, screen } from '@testing-library/react';
import { Button } from './Button';

describe('Button', () => {
  it('renders with correct text', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument();
  });

  it('calls onClick when clicked', async () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click me</Button>);
    
    await user.click(screen.getByRole('button'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});
```

#### Component with Context
```typescript
import { render, screen } from '@testing-library/react';
import { FileExplorerProvider } from '@brainstrike/file-explorer-ui';

const renderWithProvider = (ui: React.ReactElement, store = mockStore) => {
  return render(
    <FileExplorerProvider store={store}>
      {ui}
    </FileExplorerProvider>
  );
};

describe('FileTree', () => {
  it('renders files from store', () => {
    renderWithProvider(<FileTree />);
    expect(screen.getByText('test-file.txt')).toBeInTheDocument();
  });
});
```

### Hook Testing

#### Custom Hook Test
```typescript
import { renderHook, act } from '@testing-library/react';
import { useFileSelection } from './use-file-selection';

describe('useFileSelection', () => {
  it('manages file selection state', () => {
    const { result } = renderHook(() => useFileSelection());
    
    act(() => {
      result.current.selectFile('file1.txt');
    });
    
    expect(result.current.selectedFiles).toContain('file1.txt');
  });
});
```

### Integration Testing

#### Cross-Package Integration
```typescript
import { render, screen } from '@testing-library/react';
import { FileExplorerProvider } from '@brainstrike/file-explorer-ui';
import { createFileExplorerStore } from '@brainstrike/file-explorer';

describe('File Explorer Integration', () => {
  it('integrates file explorer with UI components', async () => {
    const store = createFileExplorerStore();
    
    render(
      <FileExplorerProvider store={store}>
        <FileExplorerSidebar />
        <FileTree />
      </FileExplorerProvider>
    );
    
    // Test integration between components
    expect(screen.getByRole('tree')).toBeInTheDocument();
  });
});
```

## Test Utilities

### Common Test Helpers

#### Mock Data Factories
```typescript
// test-utils/mock-data.ts
export const createMockFile = (overrides = {}) => ({
  id: 'file-1',
  name: 'test.txt',
  path: '/test.txt',
  size: 1024,
  modified: new Date(),
  ...overrides
});

export const createMockFolder = (overrides = {}) => ({
  id: 'folder-1',
  name: 'test-folder',
  path: '/test-folder',
  type: 'folder',
  children: [],
  ...overrides
});
```

#### Test Wrapper Components
```typescript
// test-utils/test-wrappers.tsx
export const TestWrapper = ({ children, store = mockStore }) => (
  <FileExplorerProvider store={store}>
    <ThemeProvider theme="light">
      {children}
    </ThemeProvider>
  </FileExplorerProvider>
);

export const renderWithProviders = (ui: React.ReactElement, options = {}) => {
  return render(ui, {
    wrapper: TestWrapper,
    ...options
  });
};
```

### Performance Testing Utilities

#### Memory Monitoring
```typescript
// test-utils/performance.ts
export const measureMemoryUsage = () => {
  if ('memory' in performance) {
    return {
      used: performance.memory.usedJSHeapSize,
      total: performance.memory.totalJSHeapSize,
      limit: performance.memory.jsHeapSizeLimit
    };
  }
  return null;
};

export const waitForMemoryCleanup = async (timeout = 5000) => {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const memory = measureMemoryUsage();
    if (memory && memory.used < memory.total * 0.8) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};
```

## CI/CD Integration

### Test Commands

#### Package-Specific Testing
```bash
# Run tests for specific package
pnpm --filter @brainstrike/file-explorer-ui test

# Run tests with coverage
pnpm --filter @brainstrike/file-explorer-ui test:coverage

# Run integration tests
pnpm --filter @brainstrike/file-explorer-ui test:integration
```

#### Monorepo Testing
```bash
# Run all tests
pnpm test

# Run tests with coverage
pnpm test:coverage

# Run E2E tests
pnpm test:e2e

# Run performance tests
pnpm test:e2e:perf
```

### Coverage Requirements

- **Unit Tests**: Minimum 80% coverage
- **Integration Tests**: Minimum 60% coverage
- **Critical Paths**: Minimum 90% coverage
- **New Code**: Must maintain or improve coverage

## Best Practices

### Test Writing Guidelines

1. **Test Behavior, Not Implementation**
   - Focus on what the component does, not how it does it
   - Test user interactions and outcomes

2. **Use Descriptive Test Names**
   ```typescript
   // Good
   it('should display error message when file upload fails')
   
   // Bad
   it('should handle error')
   ```

3. **Arrange-Act-Assert Pattern**
   ```typescript
   it('should select file when clicked', () => {
     // Arrange
     const mockFile = createMockFile();
     render(<FileTree files={[mockFile]} />);
     
     // Act
     user.click(screen.getByText(mockFile.name));
     
     // Assert
     expect(screen.getByRole('treeitem', { selected: true })).toBeInTheDocument();
   });
   ```

4. **Mock External Dependencies**
   - Mock heavy dependencies (embeddings, database)
   - Mock browser APIs (localStorage, File API)
   - Mock network requests

5. **Test Edge Cases**
   - Empty states
   - Error conditions
   - Loading states
   - Boundary conditions

### Performance Testing Guidelines

1. **Measure What Matters**
   - User-perceived performance
   - Memory usage patterns
   - Render performance

2. **Use Realistic Data**
   - Test with production-like data sizes
   - Include edge cases and boundary conditions

3. **Monitor Regressions**
   - Establish performance baselines
   - Track performance trends over time
   - Alert on significant regressions

## Troubleshooting

### Common Test Issues

#### Flaky Tests
- Use `waitFor` for async operations
- Add proper cleanup in `afterEach`
- Mock timers for time-dependent tests

#### Memory Leaks in Tests
- Dispose of resources in `afterEach`
- Clear timers and intervals
- Remove event listeners

#### Mock Issues
- Ensure mocks are reset between tests
- Use `vi.clearAllMocks()` in `beforeEach`
- Verify mock implementations match real APIs

### Debug Commands

```bash
# Run tests in watch mode
pnpm test:watch

# Run specific test file
pnpm test Button.test.tsx

# Run tests with debug output
DEBUG=pw:test pnpm test:e2e

# Generate coverage report
pnpm test:coverage
```

## Migration Guide

### From Jest to Vitest

1. **Update Configuration**
   - Replace `jest.config.js` with `vitest.config.mts`
   - Update test scripts in `package.json`

2. **Update Imports**
   ```typescript
   // Old (Jest)
   import { jest } from '@jest/globals';
   
   // New (Vitest)
   import { vi } from 'vitest';
   ```

3. **Update Mock Syntax**
   ```typescript
   // Old (Jest)
   jest.fn().mockImplementation(() => {})
   
   // New (Vitest)
   vi.fn().mockImplementation(() => {})
   ```

This testing standards document ensures consistent, maintainable, and effective testing across the entire BrainStrike monorepo.
