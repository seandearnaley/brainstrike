# React & Vitest Testing Guidelines

This document outlines best practices and guidelines for writing tests in the brainstrike-web project using Vitest and React Testing Library.

## Key Principles for Testing

1. **Prefer simplicity over complexity** - Start with simple tests that verify core functionality, then add complexity when needed.
2. **Test behavior, not implementation** - Focus on what components do, not how they're built.
3. **Use realistic user interactions** - Test from the user's perspective using screen queries and user events.
4. **Keep tests independent** - Each test should be able to run on its own without depending on other tests.

## Vitest-Specific Guidelines

### 1. Mock Order and Hoisting

**IMPORTANT**: Vitest hoists `vi.mock()` calls to the top of the file before any imports. This can lead to subtle bugs.

❌ **Incorrect** (causes "Cannot access X before initialization" errors):
```typescript
import { someFunction } from './module';
const mockValue = { id: 'test' };

vi.mock('./module', () => ({
  someFunction: vi.fn().mockReturnValue(mockValue),
}));
```

✅ **Correct** approach:
```typescript
// Define mocks first
vi.mock('./module', () => ({
  someFunction: vi.fn().mockReturnValue({ id: 'test' }),
}));

// Import after mocking
import { someFunction } from './module';
```

### 2. Async Testing Practices

When testing components with async operations:

1. **Prefer controlled rerendering** over waiting for all async operations:
```typescript
// Render component
const { rerender } = render(<MyAsyncComponent />);

// Verify initial loading state
expect(screen.getByText('Loading...')).toBeInTheDocument();

// Force rerender to simulate load completion
rerender(<MyAsyncComponent />);

// Verify loaded state
expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
```

2. **For essential waiting, use `vi.dynamicImportSettled()` or explicit promises**:
```typescript
// Wait for dynamic imports and async operations to complete
await vi.dynamicImportSettled();
```

### 3. Mock Cleanup

Always clean up mocks between tests to prevent test contamination:

```typescript
beforeEach(() => {
  vi.clearAllMocks();
});

// For more thorough cleanup when needed
afterEach(() => {
  vi.resetAllMocks();
});
```

## React Testing Library Guidelines

### 1. Query Selection Priority

When selecting elements, follow this priority order:
1. Accessible queries (role, label, placeholder, text) that reflect how users find elements
2. Test IDs as a last resort, not as the default approach

```typescript
// Preferred: queries that reflect how users interact with your UI
screen.getByRole('button', { name: /submit/i });
screen.getByLabelText('Username');
screen.getByPlaceholderText('Enter your password');
screen.getByText('Welcome back!');

// Use test IDs only when necessary
screen.getByTestId('user-dropdown');
```

### 2. When Tests Are Failing

If tests are failing in mysterious ways:

1. **Scale back** - Reduce test complexity and focus on one assertion
2. **Check rendered output** - Use `screen.debug()` to see the actual rendered HTML
3. **Verify your mocks** - Ensure mocks are working as expected
4. **Consider a fresh approach** - Sometimes it's easier to rewrite a test than to debug a complex one

### 3. Component Mocking Strategy

When mocking components:

1. **Mock as little as possible** - Only mock external dependencies, not the component under test
2. **Use realistic mock implementations** - Mocks should behave like the real components
3. **For UI component libraries** - Mock at the component level, not the library level

```typescript
// Mock a specific UI component
vi.mock('@/components/ui/button', () => ({
  Button: (props) => <button {...props} />
}));
```

## Testing UI Components

For shadcn/ui and other UI components:

1. **Focus on accessibility roles** - Test components by their semantic role
2. **Test user interactions** - Verify that clicking, typing, etc. work as expected
3. **Check state changes** - Verify that components update correctly when props or state change

## Example Test Structure

```typescript
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';

// 1. Mock dependencies
vi.mock('./dependency', () => ({
  useSomething: vi.fn().mockReturnValue({ data: 'test' }),
}));

// 2. Import the component under test (after mocks)
import { MyComponent } from './my-component';

describe('MyComponent', () => {
  // 3. Setup and cleanup
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 4. Tests in order of complexity (simple -> complex)
  test('renders correctly', () => {
    render(<MyComponent />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  test('handles user interaction', async () => {
    render(<MyComponent />);
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Clicked')).toBeInTheDocument();
  });
});
```

## Troubleshooting Common Issues

| Issue | Solution |
|-------|----------|
| "Cannot access X before initialization" | Move `vi.mock()` calls before imports |
| Elements not found in DOM | Use `screen.debug()` to see what's actually rendered |
| Async tests timing out | Use explicit control with `rerender` or increase timeout |
| Mock not being called | Verify mock is correctly implemented and imported |
| Tests passing individually but failing together | Check for state leakage between tests | 