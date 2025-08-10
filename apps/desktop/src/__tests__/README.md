# Desktop App Test Suite

This directory contains the comprehensive test suite for the BrainStrike Desktop application. The tests are organized by functionality and use Vitest as the testing framework.

## Test Structure

```
src/__tests__/
├── setup.ts                           # Global test setup and mocks
├── integration/                       # Integration tests
│   └── app-initialization.test.tsx    # App initialization and DOM tests
├── main/                              # Main process tests
│   └── ipc-handlers.test.ts          # IPC handler behavior tests
├── renderer/                         # Renderer process tests
│   ├── adapters.test.ts              # Electron adapter tests
│   └── components/                   # React component tests
│       ├── home-page-content.test.tsx
│       └── root-layout-content.test.tsx
└── README.md                         # This file
```

## Test Categories

### 1. Setup Tests (`setup.ts`)
- Global test configuration
- Electron API mocks
- React Router mocks
- Testing library setup

### 2. Integration Tests (`integration/`)
- **App Initialization**: Tests basic app setup, DOM environment, and Electron API availability
- Focuses on high-level functionality without complex dependencies

### 3. Main Process Tests (`main/`)
- **IPC Handlers**: Tests the expected behavior of Inter-Process Communication handlers
- **Adapter Functionality**: Tests storage and file system adapter behavior
- **Channel Naming**: Validates IPC channel naming conventions

### 4. Renderer Process Tests (`renderer/`)
- **Adapters**: Tests Electron renderer adapters for file system and storage
- **Components**: Tests React components with proper mocking

## Running Tests

### Basic Test Commands

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm run test:watch

# Run tests with coverage
pnpm run test:coverage

# Type check
pnpm run type-check
```

### Test Coverage

The test suite provides coverage for:
- ✅ Renderer components (100% coverage)
- ✅ Adapter functionality
- ✅ IPC communication patterns
- ✅ Basic app initialization
- ⚠️ Main process files (excluded from coverage as they require Electron runtime)

Current coverage: ~30% overall (100% for testable renderer components)

## Test Philosophy

### What We Test
1. **Component Rendering**: Ensure React components render without errors
2. **Adapter Interfaces**: Verify adapters call correct IPC channels with proper parameters
3. **API Structure**: Validate that Electron APIs have expected structure
4. **Error Handling**: Test graceful handling of missing DOM elements
5. **Integration Points**: Basic app initialization and environment setup

### What We Don't Test
1. **Actual Electron Runtime**: Main process requires full Electron environment
2. **Complex Package Dependencies**: Avoided to prevent test brittleness
3. **File System Operations**: Mocked to avoid filesystem dependencies
4. **Network Requests**: Not applicable to current desktop app scope

## Mocking Strategy

### Electron APIs
- `window.electronAPI` is mocked with all required methods
- IPC communication is mocked at the `ipcRenderer.invoke` level
- File system and storage adapters return predictable mock data

### React Dependencies
- `react-helmet-async`: Mocked to avoid SSR complexity
- `react-router-dom`: Mocked with basic navigation functions
- `@brainstrike/*` packages: Mocked with simple component stubs

### External Dependencies
- All shared packages are mocked to avoid complex dependency chains
- UI components are replaced with simple test-friendly alternatives

## Adding New Tests

### For New Components
1. Create test file in appropriate subdirectory
2. Mock external dependencies
3. Test rendering and basic functionality
4. Follow existing naming conventions

### For New Adapters
1. Add tests to `renderer/adapters.test.ts`
2. Test all public methods
3. Verify correct IPC channel usage
4. Test error scenarios

### For New IPC Handlers
1. Add tests to `main/ipc-handlers.test.ts`
2. Test expected channel registration
3. Verify adapter method calls
4. Test naming conventions

## Best Practices

1. **Keep Tests Simple**: Focus on behavior, not implementation details
2. **Mock External Dependencies**: Avoid complex package interactions
3. **Test Error Cases**: Include negative test scenarios
4. **Use Descriptive Names**: Test names should clearly describe what's being tested
5. **Group Related Tests**: Use `describe` blocks to organize related functionality

## Troubleshooting

### Common Issues

1. **Module Not Found**: Check if new dependencies need mocking
2. **Type Errors**: Ensure TypeScript types are properly configured
3. **Mock Failures**: Verify mock structure matches actual API
4. **Coverage Issues**: Check if files are properly excluded from coverage

### Debug Tips

1. Use `screen.debug()` to see rendered DOM
2. Check mock call history with `vi.mocked(fn).mock.calls`
3. Use `--reporter=verbose` for detailed test output
4. Run single test files with `vitest run specific-file.test.ts`

## Future Improvements

1. **E2E Tests**: Add Playwright tests for full app workflows
2. **Performance Tests**: Add tests for large file handling
3. **Accessibility Tests**: Add a11y testing with testing-library/jest-dom
4. **Visual Regression**: Consider adding visual testing for UI components
5. **Main Process Testing**: Explore testing strategies for Electron main process 
