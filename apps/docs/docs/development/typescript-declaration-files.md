---
title: TypeScript Declaration Files
sidebar_position: 5
---

# TypeScript Declaration Files (.d.ts) in Monorepos: A Complete Guide

## Table of Contents
- [What Are Declaration Files?](#what-are-declaration-files)
- [The Problem We Encountered](#the-problem-we-encountered)
- [Understanding TypeScript Project References](#understanding-typescript-project-references)
- [The Root Cause](#the-root-cause)
- [Common Mistakes and Pitfalls](#common-mistakes-and-pitfalls)
- [The Correct Solution](#the-correct-solution)
- [Best Practices Going Forward](#best-practices-going-forward)
- [Troubleshooting Guide](#troubleshooting-guide)
- [Alternative Approaches](#alternative-approaches)

## What Are Declaration Files?

TypeScript declaration files (`.d.ts`) are files that contain only type information without any implementation. They serve several critical purposes:

### Why Declaration Files Matter
1. **Type Safety**: They provide type information for JavaScript libraries and compiled TypeScript modules
2. **IntelliSense**: Enable autocomplete, parameter hints, and error checking in IDEs
3. **Package Distribution**: Allow TypeScript packages to be consumed by other TypeScript projects
4. **Project References**: Enable TypeScript to understand dependencies between packages in a monorepo

### Example Declaration File
```typescript
// index.d.ts
export declare function createLogger(prefix: string): {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
};

export declare interface LoggerConfig {
    enableInProduction?: boolean;
    prefix?: string;
    includeTimestamp?: boolean;
}
```

## The Problem We Encountered

### Initial Issue
Our `@brainstrike/file-explorer-hooks` package was building successfully but **not generating the required `index.d.ts` file**. This caused a cascading build failure:

```bash
src/app-layout.tsx(1,29): error TS6305: Output file 
'/packages/file-explorer-hooks/dist/index.d.ts' has not been built 
from source file '/packages/file-explorer-hooks/src/index.ts'.
```

### What This Error Means
- TypeScript was looking for declaration files from our package
- The package was set up to use TypeScript project references
- Other packages depended on this package's type information
- The build system expected `.d.ts` files but they weren't being generated

## Understanding TypeScript Project References

### What Are Project References?
Project references allow you to structure TypeScript programs as smaller, independent pieces. In a monorepo, they enable:

1. **Incremental Builds**: Only rebuild packages that have changed
2. **Dependency Management**: Ensure packages build in the correct order
3. **Type Safety**: Share type information between packages
4. **Parallel Builds**: Build independent packages simultaneously

### How They Work
```json
// tsconfig.json
{
  "compilerOptions": {
    "composite": true,  // Required for project references
    "declaration": true // Generate .d.ts files
  },
  "references": [
    { "path": "../other-package" }
  ]
}
```

### The `composite` Flag
When `composite: true` is set:
- TypeScript generates both `.js` and `.d.ts` files
- Creates a `.tsbuildinfo` file for incremental builds
- Enables the package to be referenced by other projects
- **Changes how TypeScript compiler options work**

## The Root Cause

### The Fatal Combination
Our configuration had a critical incompatibility:

```json
{
  "compilerOptions": {
    "composite": true,
    "emitDeclarationOnly": true  // ❌ This doesn't work with project references!
  }
}
```

### Why This Fails
According to the [TypeScript documentation](https://github.com/microsoft/TypeScript/issues/47406):

> **`emitDeclarationOnly` is not compatible with `tsc --build`** when using project references.

The reasons:
1. `tsc --build` expects both `.js` and `.d.ts` outputs for referenced projects
2. `emitDeclarationOnly` tells TypeScript to skip `.js` generation
3. This creates an inconsistency that TypeScript cannot resolve
4. The build system fails silently or generates incomplete outputs

### Our Build Pipeline
We were using:
```bash
tsc && tsup  # tsc with emitDeclarationOnly + tsup for bundling
```

With `emitDeclarationOnly: true`, this meant:
- `tsc` would try to generate only `.d.ts` files
- But project references require both `.js` and `.d.ts`
- The declaration files weren't being generated properly
- `tsup` would then clean the dist directory, removing any files that were generated

## Common Mistakes and Pitfalls

### 1. Assuming `emitDeclarationOnly` Works Everywhere
```json
// ❌ Wrong assumption
{
  "compilerOptions": {
    "composite": true,
    "emitDeclarationOnly": true  // Incompatible with composite!
  }
}
```

### 2. Using `tsup` with `clean: true` After `tsc`
```typescript
// ❌ This will delete the .d.ts files that tsc generated
export default defineConfig({
  clean: true,  // Deletes everything in outDir before building
  dts: false    // But we need the .d.ts files from tsc!
});
```

### 3. Misunderstanding Build Order
```bash
# ❌ Wrong: tsc generates .d.ts, then tsup cleans them
tsc && tsup --clean

# ✅ Correct: tsc generates everything, tsup only bundles JS
tsc && tsup --no-clean
```

### 4. Ignoring TypeScript's Incremental Builds
```bash
# ❌ This can hide the real issue
rm -rf dist && tsc  # Always rebuilds, masks caching issues
```

### 5. Not Understanding Cache Invalidation
When you change `tsconfig.json`, TypeScript might not rebuild automatically because of `.tsbuildinfo` caching:

```bash
# ❌ Change tsconfig but TypeScript thinks it's up-to-date
# because .tsbuildinfo wasn't invalidated
```

## The Correct Solution

### 1. Remove `emitDeclarationOnly`
```json
{
  "compilerOptions": {
    "composite": true,
    "declaration": true,     // Generate .d.ts files
    // "emitDeclarationOnly": true,  // ❌ Remove this line
    "outDir": "./dist"
  }
}
```

### 2. Configure `tsup` to Not Clean
```typescript
export default defineConfig({
  dts: false,      // Let tsc handle .d.ts generation
  clean: false,    // Don't clean - tsc already generated .d.ts files
  outDir: 'dist'   // Same directory as tsc
});
```

### 3. Use the Correct Build Command
```json
{
  "scripts": {
    "build": "tsc && tsup"  // tsc first, then tsup (no cleaning)
  }
}
```

### 4. Ensure Proper Cache Invalidation
When changing TypeScript configuration:
```bash
# Clear the build cache
rm -f dist/.tsbuildinfo
# Then rebuild
tsc && tsup
```

## Best Practices Going Forward

### 1. Package Structure for Monorepos
```
packages/
├── package-a/
│   ├── src/
│   ├── dist/           # Build output
│   ├── tsconfig.json   # Package-specific config
│   ├── tsup.config.ts  # Bundler config
│   └── package.json
└── package-b/
    ├── src/
    ├── dist/
    ├── tsconfig.json
    └── package.json
```

### 2. Standard `tsconfig.json` for Referenced Packages
```json
{
  "extends": "../../config/tsconfig/base.json",
  "compilerOptions": {
    "composite": true,
    "incremental": true,
    "tsBuildInfoFile": "./dist/.tsbuildinfo",
    "declaration": true,
    "declarationMap": true,
    "outDir": "./dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "**/*.test.ts"],
  "references": [
    { "path": "../dependency-package" }
  ]
}
```

### 3. Standard `tsup.config.ts` for Referenced Packages
```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: false,           // Let tsc handle declarations
  outDir: 'dist',
  clean: false,         // Don't clean - preserve .d.ts files
  target: 'es2020',
  external: [
    // List your external dependencies
    'react',
    '@your-org/other-packages'
  ]
});
```

### 4. Standard `package.json` Scripts
```json
{
  "scripts": {
    "build": "tsc && tsup",
    "dev": "tsup --watch",
    "clean": "rimraf dist .tsbuildinfo",
    "type-check": "tsc --noEmit"
  }
}
```

### 5. When to Use Different Approaches

#### Use `tsc + tsup` When:
- ✅ Building library packages in a monorepo
- ✅ Using TypeScript project references
- ✅ Need both declaration files and bundled output
- ✅ Want to maintain compatibility with TypeScript tooling

#### Use `tsup` with `dts: true` When:
- ✅ Building standalone packages
- ✅ Not using TypeScript project references
- ✅ Want a single build tool for everything
- ✅ Building applications (not libraries)

#### Use plain `tsc` When:
- ✅ Building pure TypeScript libraries
- ✅ Don't need bundling or minification
- ✅ Want the simplest possible setup
- ✅ Building Node.js applications

## Troubleshooting Guide

### Problem: "Output file has not been built from source file"
**Solution**: Check if declaration files exist and rebuild with cache clearing:
```bash
ls packages/your-package/dist/*.d.ts  # Check if files exist
rm -f packages/your-package/dist/.tsbuildinfo  # Clear cache
tsc && tsup  # Rebuild
```

### Problem: Declaration files disappear after build
**Solution**: `tsup` is cleaning them. Set `clean: false` in tsup config.

### Problem: TypeScript says project is "up to date" but files are missing
**Solution**: Clear the build info cache:
```bash
rm -f dist/.tsbuildinfo
tsc --build --force
```

### Problem: Build works locally but fails in CI
**Solution**: Ensure build order and check if cache directories exist:
```bash
# In CI, ensure clean state
rm -rf dist/
pnpm build
```

### Problem: Cannot find module after build
**Solution**: Check package.json exports and file paths:
```json
{
  "main": "./dist/index.js",
  "module": "./dist/index.mjs", 
  "types": "./dist/index.d.ts",  // ← Make sure this file exists
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.mjs",
      "require": "./dist/index.js"
    }
  }
}
```

## Alternative Approaches

### Option 1: Pure tsup (No Project References)
If you don't need project references, you can use tsup exclusively:

```typescript
// tsup.config.ts
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,        // Let tsup handle everything
  clean: true,      // Safe to clean since tsup generates everything
  splitting: false,
  sourcemap: true
});
```

```json
// tsconfig.json (simpler)
{
  "compilerOptions": {
    // No composite, no project references
    "declaration": true,
    "outDir": "./dist"
  }
}
```

### Option 2: Pure tsc (No Bundling)
For packages that don't need bundling:

```json
// package.json
{
  "scripts": {
    "build": "tsc"
  }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "outDir": "./dist"
  }
}
```

### Option 3: Separate Declaration and Bundle Builds
Generate declarations separately from bundles:

```json
{
  "scripts": {
    "build:types": "tsc --emitDeclarationOnly",
    "build:js": "tsup --dts false",
    "build": "npm run build:types && npm run build:js"
  }
}
```


## NOTES:

`.tsbuildinfo` is a file that TypeScript uses to track the state of the build. It is created by the TypeScript compiler and is used to speed up the build process. In some cases this doesnt get updated correctly and you need to clear the cache, worth trying if you're not seeing index.d.ts files in your dist folder.

## Conclusion

The key takeaway is that **TypeScript project references and `emitDeclarationOnly` are incompatible**. When using project references in a monorepo:

1. **Always use `composite: true`** for referenced packages
2. **Never use `emitDeclarationOnly`** with project references
3. **Let `tsc` generate both `.js` and `.d.ts` files**
4. **Configure bundlers to not clean the output directory**
5. **Understand build tool interactions** and their order of operations

By following these practices, you'll avoid the frustrating "missing declaration files" issues that can plague TypeScript monorepos and maintain a robust, scalable build system.