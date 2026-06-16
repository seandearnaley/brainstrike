# @brainstrike/config

Shared configuration files for the BrainStrike monorepo, providing consistent TypeScript and Playwright settings across all packages and applications.

## Overview

This package centralizes configuration for:
- TypeScript compiler settings
- Playwright test environment setup

By extending shared configs, all packages maintain consistency in type-checking, build output, and testing behavior.

## Contents

### TypeScript Configurations

Located in `tsconfig/`:

#### `base.json`
Strict TypeScript configuration for all packages.

**Key settings:**
- **Strict mode**: Full strictness enabled (`strict: true`)
- **Module system**: ESNext with Bundler resolution
- **JSX**: React JSX transform
- **Safety**: `noUncheckedIndexedAccess`, `noImplicitAny`, `exactOptionalPropertyTypes`
- **Output**: Declaration files, source maps, declaration maps
- **Target**: ES2020

#### `react-library.json`
Extends `base.json` with React-specific settings for component libraries.

### Playwright Environment

Located in `src/playwright-environment.ts`:

Custom Playwright test environment configuration for consistent E2E testing across web and desktop applications.

## Usage

### In Package TypeScript Config

Extend the base configuration in your package's `tsconfig.json`:

```json
{
  "extends": "@brainstrike/config/tsconfig/base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "__tests__"]
}
```

### For React Libraries

Use the React-specific configuration:

```json
{
  "extends": "@brainstrike/config/tsconfig/react-library.json",
  "compilerOptions": {
    "outDir": "./dist"
  }
}
```

### Playwright Environment

Import in Playwright configuration:

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  // Use shared test environment from config package
  // ...
});
```

## Installation

This is an internal workspace package. Add to your `package.json`:

```json
{
  "devDependencies": {
    "@brainstrike/config": "workspace:*"
  }
}
```

## TypeScript Compiler Options

The base configuration enforces:

### Type Safety
- `strict: true` - Maximum type safety
- `noImplicitAny: true` - No implicit any types
- `noUncheckedIndexedAccess: true` - Array/object access returns `T | undefined`
- `exactOptionalPropertyTypes: true` - Optional properties cannot be undefined explicitly
- `noPropertyAccessFromIndexSignature: true` - Use bracket notation for dynamic keys

### Code Quality
- `noUnusedLocals: true` - Detect unused variables
- `noUnusedParameters: true` - Detect unused function parameters
- `noFallthroughCasesInSwitch: true` - Require break/return in switch cases
- `noImplicitReturns: true` - All code paths must return a value
- `allowUnreachableCode: false` - Error on unreachable code
- `allowUnusedLabels: false` - Error on unused labels

### Module System
- `module: "ESNext"` - Modern ES module syntax
- `moduleResolution: "Bundler"` - Bundler-aware resolution (Vite, webpack)
- `esModuleInterop: true` - CommonJS interop
- `isolatedModules: true` - Required for transpilers
- `verbatimModuleSyntax: true` - Explicit import/export type syntax

### Build Output
- `declaration: true` - Generate .d.ts files
- `declarationMap: true` - Generate .d.ts.map files
- `sourceMap: true` - Generate source maps
- `removeComments: false` - Preserve comments in output

### React Support
- `jsx: "react-jsx"` - Use new JSX transform (no React import needed)
- `lib: ["DOM", "DOM.Iterable", "ESNext"]` - DOM and modern APIs

### Advanced Features
- `experimentalDecorators: true` - Enable decorators
- `emitDecoratorMetadata: true` - Emit decorator metadata
- `forceConsistentCasingInFileNames: true` - Enforce file name casing

## File Structure

```
packages/config/
├── tsconfig/
│   ├── base.json           # Base TypeScript configuration
│   ├── react-library.json  # React library configuration
│   └── package.json        # Package descriptor for tsconfig
├── src/
│   └── playwright-environment.ts  # Playwright environment setup
├── package.json
└── README.md
```

## Exports

The package provides the following exports:

```json
{
  "./tsconfig/*": "./tsconfig/*.json",
  "./playwright-environment": "./src/playwright-environment.ts"
}
```

## Development

This package contains only configuration files and has minimal development commands:

```bash
# Type check (validates configuration)
pnpm type-check

# Lint
pnpm lint

# Run tests
pnpm test

# Clean
pnpm clean
```

## Extending Configurations

### Adding Custom Options

When extending, you can override any option:

```json
{
  "extends": "@brainstrike/config/tsconfig/base.json",
  "compilerOptions": {
    "target": "ES2022",  // Override target
    "lib": ["ESNext"]     // Override lib
  }
}
```

### Application-Specific Configs

Applications may need additional settings:

```json
{
  "extends": "@brainstrike/config/tsconfig/base.json",
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "references": [
    { "path": "../../packages/ui" },
    { "path": "../../packages/types" }
  ]
}
```

## See Also

- [TypeScript Handbook - tsconfig.json](https://www.typescriptlang.org/tsconfig)
- [Playwright Configuration](https://playwright.dev/docs/test-configuration)
