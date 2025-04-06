# Testing Guidelines

This document outlines comprehensive testing standards for our Vite application using Vitest, React Testing Library, and Playwright. It serves as a guide for all developers and AI systems contributing to our codebase to ensure consistent, reliable, and maintainable tests.

## Our Dev Dependencies

## General Principles

- **Deterministic Tests**: Ensure tests produce the same results every time they run.
- **Isolation**: Keep tests independent; they should not rely on the state or outcome of other tests.
- **Clarity and Readability**: Use descriptive names and clear structures to make tests understandable.
- **Behavior Focused**: Test the behavior and user interactions rather than internal implementation details.
- **Arrange, Act, Assert (AAA)**: Follow this pattern to organize tests for consistency.

## Test Types and Tools

### Unit Tests

- **Tool**: Vitest with React Testing Library
- **Purpose**: Test individual components, hooks, and utility functions in isolation.
- **Coverage Target**: Included in the overall 70% coverage requirement.

### Integration Tests

- **Tool**: Vitest with React Testing Library
- **Purpose**: Test interactions between components and modules.
- **Coverage Target**: Included in the overall 70% coverage requirement.

### End-to-End (E2E) Tests

- **Tool**: Playwright
- **Purpose**: Test full user flows in a real browser environment.
- **Browsers**: Chrome, Firefox, Safari
- **Devices**: Desktop and Mobile (e.g., Pixel 5, iPhone 12)

## Test Structure

### File Organization

- **Placement**: Place test files next to the code they test.
- **Naming**: Use `.test.ts`, `.test.tsx`, `.spec.ts`, or `.spec.tsx` suffixes.
- **Directories**:
  - Use `__tests__` directories for organizing tests in larger modules.
  - Mirror the source code structure for easy navigation.

### Test Suites

- Use `describe` blocks to group related tests.
- Write individual test cases using `it` or `test` with descriptive names.

### Directory Structure Example

```
src/
├── components/
│   └── [ComponentName]/
│       ├── [ComponentName].tsx
│       └── __tests__/
│           ├── [ComponentName].test.tsx
│           └── [ComponentName].integration.test.tsx
├── hooks/
│   └── useCustomHook.ts
│   └── __tests__/
│       └── useCustomHook.test.ts
└── e2e/
    └── [FeatureName].spec.ts
```

## Vitest Configuration & Implementation Details

Vitest is configured within the main `vite.config.mts` file. For detailed information on:

- The specific Vitest configuration options used.
- How to mock modules and dependencies using `vi.mock()` and `vi.spyOn()`.
- Best practices for testing components and hooks with Vitest and React Testing Library.
- Handling async tests and timer mocks (`vi.useFakeTimers()`, etc.).
- Common Vitest API usage and replacements for Jest functions.

Please refer to the detailed **[Jest to Vitest Migration Guide](jest-vitest-migration.md)**.

## Playwright E2E Guidelines

### Test Structure

- **Grouping Tests**: Use `test.describe` to group related tests.
- **Setup Hooks**: Use `test.beforeEach` for common setup steps.

  ```typescript
  import { test, expect } from '@playwright/test';

  test.describe('Feature Flow', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/');
    });

    test('completes the end-to-end flow', async ({ page }) => {
      await page.click('text=Start');
      await page.fill('input[name="search"]', 'query');
      await page.click('text=Submit');
      await expect(page.locator('text=Results')).toBeVisible();
    });
  });
  ```

### Visual Testing

- Use Playwright's snapshot testing for visual regression.

  ```typescript
  test('matches the homepage snapshot', async ({ page }) => {
    await page.goto('/');
    expect(await page.screenshot()).toMatchSnapshot('homepage.png');
  });
  ```

## Running Tests

### Unit and Integration Tests (Vitest)

```bash
# Run all Vitest tests
npm run vitest
# or
npm run test:unit # Alias for unit tests
npm run test:integration # Alias for integration tests

# Run tests with coverage
npm run vitest:coverage

# Run tests in watch mode
npm run vitest:watch

# Run tests with UI
npm run vitest:ui
```

### E2E Tests (Playwright)

```bash
# Run E2E tests headless
npm run test:e2e

# Run E2E tests with UI
npm run test:e2e:ui
```

## Coverage Requirements

- **Minimum Coverage**: 70% for branches, functions, lines, and statements.
- **Enforcement**: Coverage thresholds are enforced via Vitest configuration within `vite.config.mts`.
- **Reporting**: View coverage reports after running `npm run vitest:coverage`.

## Testing Auth0 Protected Routes

- Mock Auth0 authentication for testing protected routes.

  ```typescript
  jest.mock('@auth0/nextjs-auth0', () => ({
    withPageAuthRequired: (component) => component,
    useUser: () => ({
      user: { email: 'test@example.com' },
      isLoading: false
    })
  }));
  ```

## Component Testing Checklist

- **Rendering**: Component renders without errors.
- **User Interactions**: Handles clicks, inputs, and other events.
- **Error States**: Displays appropriate messages or UI elements.
- **Loading States**: Manages loading indicators and states.
- **Edge Cases**: Handles unexpected or extreme input values.
- **Accessibility**: Complies with ARIA roles and accessibility standards.
- **Responsive Behavior**: Adapts to different screen sizes.
- **Context Integration**: Works correctly with context providers.
- **Event Handlers**: Calls callbacks and event handlers as expected.
- **Prop Validation**: Validates props and handles missing or incorrect props.

## Code Quality Checks

- **TypeScript**: Use TypeScript for type safety in all test files.
- **Linting**: Ensure test files pass all linting rules.
- **Naming Conventions**: Use consistent naming for test files and test cases.
- **Colocation**: Keep test files close to the components they test.
- **DRY Principle**: Avoid duplication by using setup functions and test utilities.

## Continuous Integration (CI) Integration

- **Automated Testing**: Tests run automatically in CI environments using GitHub Actions.
- **Coverage Reporting**: Coverage reports are generated and reviewed for each pull request.
- **Parallel Execution**: Tests run in parallel to reduce CI pipeline time.
- **Environment Consistency**: Tests run in environments similar to production.

---

By adhering to these guidelines, we ensure that our codebase remains robust, maintainable, and reliable. Happy testing!