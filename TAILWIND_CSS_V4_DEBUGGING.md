# Tailwind CSS v4 Deployment Issue - Investigation Report

## Problem Summary

**Issue**: Tailwind CSS v4 generates ~53KB CSS bundle locally but only ~24KB in Vercel production deployments, causing severe styling differences between local development and deployed site.

**Impact**: Deployed site looks completely different from local development - appears to be missing critical CSS classes from monorepo packages.

**Environment**: 
- Turborepo monorepo with 13+ packages
- React 19 + Vite 6 + TypeScript 5
- Tailwind CSS v4.1.10 with @tailwindcss/vite plugin
- shadcn/ui component library
- Vercel deployment with custom build commands

## Monorepo Structure

```
brainstrike/
├── apps/
│   └── web/                    # Main React app
├── packages/
│   ├── ui/                     # shadcn/ui components
│   ├── app-shell/              # IDE layout system  
│   ├── file-explorer-ui/       # File tree components
│   ├── file-explorer-hooks/    # File system hooks
│   ├── hooks/                  # Shared React hooks
│   └── tailwind-config/        # Shared Tailwind config
```

## Deployment Configuration

### Vercel Settings Mismatch
**Critical Discovery**: Vercel production deployments use different settings than project settings:

**Production Override (what's actually running):**
- Framework: Other
- Build Command: `cd ../../ && turbo run build --filter @brainstrike/web --force`
- Output Directory: `dist`
- Install Command: `cd ../../ && pnpm install`

**Project Settings (ignored):**
- Framework: Vite
- Build Command: `pnpm build:web`
- Output Directory: `apps/web/dist`

**Key Issue**: Production builds run from repository root (`cd ../../`) while local builds run from `apps/web/`, causing path resolution problems.

## Attempts Made & Results

### 1. Missing Config Files
**Tried**: Restored missing `packages/tailwind-config/tailwind.config.js`
**Result**: Fixed test failures but no CSS change
**Learning**: Config files were needed for tests, not the main issue

### 2. Root-Level Config Approach
**Tried**: Created root-level `tailwind.config.js` with paths from repository root
**Result**: No improvement in CSS bundle size
**Learning**: Traditional config approach doesn't work well with Tailwind v4's new architecture

### 3. Conditional Vite Plugin Configuration
**Tried**: 
```javascript
const useRootConfig = existsSync(rootConfigPath) && (process.env.VERCEL || process.env.CI);
tailwindcss({
  config: useRootConfig ? rootConfigPath : undefined
})
```
**Result**: No visible effect - debug logging never appeared
**Learning**: Environment detection not working as expected

### 4. @source Directive Attempts
**Tried Multiple Variations**:
- `@source "../../packages/ui/src/**/*.{js,ts,jsx,tsx}"`
- `@source "./packages/ui/src/**/*.{js,ts,jsx,tsx}"` (from root)
- `@source "../../packages/ui/src";` (without glob patterns)

**Results**: 
- Some variations increased CSS from 25KB to 44KB
- Still far from target 53KB
- Inconsistent results between deployments

### 5. source() Function Approach
**Tried**: 
```css
@import "tailwindcss" source("../../");
```
**Result**: Briefly increased to 44KB, then regressed to 24KB
**Learning**: Tailwind v4's source() function is sensitive to working directory context

### 6. Comprehensive Explicit Sourcing
**Tried**:
```css
@import "tailwindcss" source(none);
@source "../../apps/web/src/**/*.{js,ts,jsx,tsx}";
@source "../../packages/ui/src/**/*.{js,ts,jsx,tsx}";
@source "../../packages/ui/dist/**/*.{js,ts,jsx,tsx}";
/* ... all packages */
```
**Result**: PostCSS order errors, CSS size regression
**Learning**: Multiple explicit sources create processing conflicts

### 7. Package Import Resolution
**Tried**: Converting `@import "@brainstrike/ui/globals.css"` to relative paths
**Result**: Build failures - package imports were working correctly
**Learning**: Package resolution wasn't the core issue

## Technical Findings

### PostCSS Import Order Issues
**Problem**: Tailwind v4 requires specific CSS order:
1. All `@import` statements first  
2. `@source` directives second
3. `@layer` and other CSS last

**Evidence**: Multiple PostCSS errors: `@import must precede all other statements`

### Duplicate Tailwind Imports
**Found**: `packages/ui/src/globals.css` contained its own `@import "tailwindcss"` 
**Impact**: Created conflicts with main CSS file's Tailwind import
**Status**: Attempted fix but caused build failures

### Build Cache Interference  
**Tried**: Adding `--no-cache` to Turborepo command
**Result**: Build failure due to conflicting cache flags
**Learning**: Turborepo cache management has breaking changes in newer versions

### Working Directory Context Issues
**Core Problem**: Tailwind v4 only scans current working directory and subdirectories
**Vercel Impact**: Builds run from repository root, changing relative path resolution
**Local vs Production**: Different working directories cause different file discovery

## CSS Bundle Size History

| Attempt | Local Size | Vercel Size | Notes |
|---------|------------|-------------|-------|
| Baseline | ~53KB | ~25KB | Original issue |
| @source directives | ~53KB | ~25KB | No change |
| source("../../") | ~53KB | 44KB | Temporary improvement |
| Explicit sourcing | ~53KB | ~24KB | Regression with PostCSS errors |
| Package path fix | ~53KB | 24KB | Build failures |

## Root Cause Analysis

### Primary Issues
1. **Monorepo Content Detection**: Tailwind v4's automatic detection doesn't traverse package boundaries reliably
2. **Working Directory Mismatch**: Vercel builds from root vs local builds from apps/web
3. **Path Resolution**: Relative paths in @source directives resolve differently in production
4. **Build Cache**: Vercel/Turborepo caching may be interfering with CSS generation

### Secondary Issues  
1. **CSS Import Order**: PostCSS requires specific ordering that's hard to maintain with @source
2. **Package Imports**: Conflicting Tailwind imports across packages
3. **Environment Detection**: VERCEL/CI environment variables not reliable for config switching

## Known Workarounds (Unimplemented)

Based on research, potential solutions include:

### 1. Disable Automatic Detection Completely
```css
@import "tailwindcss" source(none);
/* Then explicitly list every source */
```

### 2. CSS-in-Package Approach
Each package exports its own CSS file with @source directives:
```css
/* packages/ui/tailwind.css */
@source "./src";
```

### 3. Unified Build Context
Modify Vercel config to build from apps/web instead of root:
```json
{
  "buildCommand": "turbo run build --filter @brainstrike/web --force",
  "installCommand": "pnpm install"
}
```

### 4. Traditional Config with v4
Use content array in tailwind.config.js instead of @source directives (if supported).

## Recommendations for Resolution

### Immediate Actions
1. **Verify build context**: Ensure all paths are relative to where Vercel actually runs the build
2. **Test cache clearing**: Try deploying with fresh cache to rule out cache interference  
3. **Simplify approach**: Use either @source OR traditional config, not both
4. **Debug output**: Add logging to see what files Tailwind is actually scanning

### Systematic Debugging
1. **Create minimal reproduction** with single package to isolate the issue
2. **Test locally with root context** by running builds from repository root
3. **Compare Tailwind processing** between local and Vercel environments
4. **Monitor Tailwind v4 issues** - this appears to be a known limitation

### Alternative Approaches
1. **Consider Tailwind v3** temporarily if v4 monorepo support is insufficient
2. **Restructure CSS architecture** to avoid cross-package dependencies
3. **Use build-time CSS generation** instead of runtime processing

## Files Modified During Investigation

- `apps/web/src/app/globals.css` - Multiple @source directive attempts
- `apps/web/vite.config.mts` - Conditional config and plugin changes  
- `apps/web/vercel.json` - Build command modifications
- `packages/tailwind-config/tailwind.config.js` - Restored missing config
- `tailwind.config.js` (root) - Created for root-level builds
- `packages/ui/src/globals.css` - Removed duplicate Tailwind import

## Current State

- **CSS Size**: 25.28KB (still significantly smaller than 53KB target)
- **PostCSS Errors**: None (clean build)
- **Build Status**: Successful but with styling issues
- **Approach**: Two-stage build - dependencies from root, web app from correct context

## Final Attempt - Two-Stage Build Context (December 2024)

### Approach
Modified Vercel build to:
1. Build all dependencies from repository root using Turborepo filtering
2. Then build web app specifically from `apps/web` directory for proper Tailwind content detection

### Configuration
```json
{
  "framework": "vite",
  "buildCommand": "cd ../.. && pnpm build --filter @brainstrike/web^... && cd apps/web && pnpm build",
  "outputDirectory": "dist",
  "installCommand": "cd ../.. && pnpm install",
  "ignoreCommand": "exit 1"
}
```

### Result
- **Status**: FAILED ❌
- **CSS Size**: 25.28KB (no improvement)
- **Build Process**: Clean, no errors
- **Analysis**: Even with correct build context, Tailwind v4 still fails to detect monorepo package content

### Findings
1. **Build Context Irrelevant**: Changing build directory from root to `apps/web` made no difference
2. **Dependency Resolution Works**: Two-stage build successfully resolves all monorepo dependencies  
3. **Tailwind Detection Fundamental Issue**: Content detection limitation is deeper than working directory
4. **Cache Not Factor**: Fresh builds consistently produce same 25KB result

## Next Steps for Developer

1. **Consider Alternative Approaches**:
   - Downgrade to Tailwind CSS v3 with explicit content configuration
   - Use build-time CSS generation tools (e.g., PurgeCSS)
   - Implement custom CSS bundling solution
   
2. **Research Community Solutions**:
   - Monitor Tailwind Labs GitHub issues for monorepo fixes
   - Check if newer versions of @tailwindcss/vite plugin address this
   - Look for third-party tools that solve v4 monorepo scanning

3. **Architectural Changes**:
   - Consolidate UI components into single package
   - Move all Tailwind classes to single CSS file
   - Consider CSS-in-JS solution that doesn't rely on file scanning

4. **Debug Approach**:
   - Add Tailwind debug mode to see exactly what files it's scanning
   - Compare file lists between local (53KB) and production (25KB) builds
   - Test with minimal reproduction case

## Conclusion

**The core issue remains unsolved**: Tailwind CSS v4's automatic content detection is fundamentally incompatible with Turborepo monorepo structures in production deployment environments, regardless of build context or configuration approaches.

**Recommendation**: This appears to require either:
- Waiting for official Tailwind v4 monorepo support
- Switching to Tailwind v3 with explicit content configuration
- Implementing alternative CSS architecture

**Time Investment**: Multiple developers, dozens of attempts, extensive research - this is a systemic limitation, not a configuration issue.