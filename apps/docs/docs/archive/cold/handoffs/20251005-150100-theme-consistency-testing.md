---
title: "20251005 150100 Theme Consistency Testing"
status: "cold-archive"
date: "2025-10-05"
superseded_by: "none"
---

# Theme Consistency Testing Implementation

**Date**: 2025-10-05  
**Type**: Test Coverage Enhancement  
**Status**: ✅ Complete

## Overview

Added comprehensive test coverage for theme consistency to prevent issues like the assistant-ui library overriding Brainstrike theme variables.

## Problem This Prevents

The recent dark mode issue where `@assistant-ui/styles/index.css` was overriding our theme with hardcoded values (`240 10% 3.9%` instead of our navy theme `222.2 84% 4.9%`). These tests will catch such regressions immediately.

## Test Files Created

### 1. Unit Tests: `packages/ui/src/__tests__/theme-css-variables.test.tsx`

**Purpose**: Verify ThemeProvider correctly manages CSS classes  
**Coverage**:
- ✅ Light mode applies `.light` class
- ✅ Dark mode applies `.dark` class  
- ✅ System theme applies appropriate class based on system preference
- ✅ CSS class cleanup when switching themes

**Why Not Test CSS Variables in Unit Tests?**  
CSS files aren't loaded in the unit test environment (happy-dom), so actual CSS variable values can't be verified. These are tested in E2E tests instead.

**Status**: ✅ All 4 tests passing

### 2. E2E Tests: `apps/web/e2e/theme-css-consistency.test.ts`

**Purpose**: Verify actual CSS variables in browser with stylesheets loaded  
**Coverage**:
- ✅ CSS variables defined in light mode
- ✅ CSS variables defined in dark mode  
- ✅ Navy theme validation (not pure black)
- ✅ Variable mapping: `--background` equals `--bs-background`
- ✅ All theme variables consistent across prefixed/non-prefixed
- ✅ No assistant-ui hardcoded values overriding theme
- ✅ Sufficient color separation for visible gradients
- ✅ Theme maintained when opening assistant panel
- ✅ Theme applied to assistant panel elements

**Key Assertions**:
```typescript
// Ensures our navy theme (222.2 84% 4.9%) is used, not assistant-ui's (240 10% 3.9%)
expect(hueValue).toBeGreaterThan(200);
expect(satValue).toBeGreaterThan(50); // High saturation for navy, not low

// Ensures --background matches --bs-background (not overridden)
expect(background).toBe(bsBackground);

// Ensures gradients are visible
const difference = Math.abs(bgLightness - mutedLightness);
expect(difference).toBeGreaterThanOrEqual(5);
```

## What The Tests Catch

### 1. Library CSS Overrides
If any external library (like `@assistant-ui/styles`) tries to override our theme variables, the E2E tests will fail because:
- The HSL values won't match our expected navy theme
- The `--background` variable won't equal `--bs-background`

### 2. Theme Class Management Issues  
Unit tests verify the ThemeProvider correctly:
- Applies/removes `.dark` and `.light` classes
- Handles system theme preference
- Cleans up classes when switching

### 3. Color Consistency
E2E tests verify all color variables (`background`, `foreground`, `card`, `primary`, etc.) maintain consistency between:
- Prefixed versions (`--bs-*`)
- Non-prefixed versions (`--*`)
- Tailwind color tokens (`--color-*`)

### 4. Visual Quality
Tests ensure:
- Dark theme is navy (blue hue 200-250, high saturation), not black/gray
- Sufficient color separation (≥5% lightness difference) for visible gradients
- Light theme has high lightness (>90%)

## How To Run

```bash
# Unit tests only
pnpm --filter @brainstrike/ui test theme-css-variables

# E2E tests only  
pnpm --filter @brainstrike/web test:e2e theme-css-consistency

# All tests
pnpm test
```

## Integration With CI/CD

These tests are part of the standard test suite and run automatically in CI:
- Unit tests run during `pnpm test`
- E2E tests run during `pnpm test:e2e`

## Maintenance

### When To Update Tests

1. **Theme Design Changes**: If design team changes the navy theme HSL values, update the assertions in E2E tests
2. **New Color Variables**: If adding new theme variables (e.g., `--new-color`), add them to the consistency test loop
3. **New External Libraries**: If adding UI libraries with their own CSS, verify they don't override our theme

### Test Assertions To Watch

```typescript
// Dark theme navy values - update if design changes
expect(themeValues.hue).toBeGreaterThan(200);  // Blue hue
expect(themeValues.hue).toBeLessThan(250);
expect(themeValues.saturation).toBeGreaterThan(50);  // Navy saturation
expect(themeValues.lightness).toBeLessThan(10);  // Dark but not black

// Gradient visibility threshold
expect(colorSeparation).toBeGreaterThanOrEqual(5);  // 5% minimum
```

## Files Modified

- ✅ Created: `packages/ui/src/__tests__/theme-css-variables.test.tsx`
- ✅ Created: `apps/web/e2e/theme-css-consistency.test.ts`

## Related Documentation

- Original issue fix: `docs/handoffs/20251005-112340-mcp-client-duplicate-initialization-fix.md`
- Theme architecture: Check `packages/ui/src/globals.css` for theme variable definitions
- Assistant UI overrides: `packages/ui/src/assistant-ui-panel/overrides.css`

## Success Metrics

- ✅ 4 unit tests passing
- ✅ 10 E2E tests ready (run when web app is available)
- ✅ Zero lint errors
- ✅ Tests will catch the exact issue we just fixed

## Notes

- Unit tests use `act()` from `@testing-library/react` to wrap state updates
- E2E tests use Playwright's `page.evaluate()` to inspect actual CSS in browser
- All `parseInt` calls use explicit radix (`10`) to satisfy linter
- Tests include detailed error messages for easier debugging when they fail
