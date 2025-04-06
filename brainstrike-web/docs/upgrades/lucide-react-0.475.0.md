# Lucide React 0.475.0 Upgrade

## Overview

This document details the upgrade of `lucide-react` from version 0.469.0 to 0.475.0 and the necessary changes made to support Pure ESM (ECMAScript Modules) in our testing environment.

## Background

Lucide React is transitioning to Pure ESM, which means the package is now exclusively distributed as ES Modules rather than CommonJS (CJS). This change affects our testing setup because Jest, our testing framework, traditionally uses CommonJS modules.

## Changes Required

### 1. Package Update
```json
{
  "dependencies": {
    "lucide-react": "^0.475.0"
  }
}
```

### 2. Babel Dependencies

We added the following Babel dependencies to handle ESM in our test environment:

```json
{
  "devDependencies": {
    "@babel/core": "^7.24.0",
    "@babel/plugin-transform-modules-commonjs": "^7.24.0",
    "@babel/preset-env": "^7.24.0",
    "@babel/preset-react": "^7.24.0",
    "@babel/preset-typescript": "^7.24.0"
  }
}
```

These dependencies were necessary because:
- Jest runs in Node.js, which requires CommonJS modules for testing
- Babel transforms ESM code into CommonJS during testing
- We need to maintain compatibility between our modern ESM codebase and Jest's test environment

### 3. Jest Configuration Updates

Updated `jest.config.ts` to properly handle lucide-react imports:

```typescript
{
  moduleNameMapper: {
    '^lucide-react$': '<rootDir>/src/test/mocks/lucide-react.ts',
    '^lucide-react/dist/esm/icons/(.*)$': '<rootDir>/src/test/mocks/lucide-react.ts',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(@orama|lucide-react)/)',
  ],
  transform: {
    '^.+\\.(t|j)sx?$': ['babel-jest', { configFile: './babel.config.test.js' }],
  }
}
```

These changes:
- Map all lucide-react imports to our mock implementation
- Ensure Babel processes lucide-react modules instead of excluding them
- Use a test-specific Babel configuration

### 4. Icon Mocks

We implemented comprehensive mocks for lucide-react icons to:
- Improve test performance
- Avoid SVG rendering complexities in Jest's JSDOM environment
- Provide testable implementations with data-testid support

Example mock implementation:
```typescript
const createMockIcon = (name: string) => {
  const Icon = (props: ExtendedLucideProps) => {
    const { size = 24, className, 'data-testid': testId, ...rest } = props;
    return React.createElement('svg', {
      width: size,
      height: size,
      className,
      'data-testid': testId,
      ...rest,
    });
  };
  Icon.displayName = name;
  return Icon;
};
```

## Why These Changes Were Necessary

1. **Pure ESM Support**
   - Modern JavaScript is moving towards ESM as the standard module system
   - Lucide React's transition to Pure ESM reflects this industry trend
   - Our testing infrastructure needed to adapt to this change

2. **Testing Environment Compatibility**
   - Jest and Node.js still primarily use CommonJS
   - Babel transforms help bridge the gap between ESM and CommonJS
   - Mock implementations provide controlled testing environments

3. **Development vs Test Environment**
   - Production/development uses Vite's build process (which utilizes Rollup and esbuild/SWC depending on configuration).
   - Test environment uses Babel for better control and compatibility
   - This split configuration ensures optimal performance in both contexts

## Impact on Development

- No changes required for development environment (uses Vite's dev server)
- Test environment now properly handles ESM modules
- Improved icon testing with explicit test IDs
- Better separation of concerns between development and test configurations

## Future Considerations

1. **ESM in Testing**
   - Monitor Jest's native ESM support progress
   - Consider transitioning to native ESM testing when ecosystem matures

2. **Mock Maintenance**
   - Keep icon mocks updated with new lucide-react versions
   - Consider automating mock updates for new icons

3. **Build Tools**
   - Watch for Vite updates regarding ESM handling
   - Monitor SWC improvements for testing scenarios 