# E2E Testing Migration Guide

This document outlines the changes made to migrate the end-to-end (e2e) testing setup to the Turborepo monorepo structure.

## Summary of Changes

1. **Directory Structure Changes**
   - Moved e2e tests from project root to `apps/web/e2e/`
   - Moved Playwright configuration from root to `apps/web/playwright.config.ts`
   - Removed duplicate files at the root level

2. **Dependencies**
   - Added `@playwright/test` as a dev dependency in `apps/web/package.json`
   - Added `concurrently` for running tests with a development server
   - Installed Playwright browsers using `npx playwright install`

3. **Scripts**
   - Added e2e test scripts to `apps/web/package.json`:
     - `test:e2e`: Run all e2e tests
     - `test:e2e:ui`: Run tests with the Playwright UI
     - `test:e2e:debug`: Run tests in debug mode
     - `test:e2e:direct`: Run tests with explicit debug environment variables
     - `test:e2e:sh`: Run tests with a shell script for improved reliability
     - `test:e2e:headless`: Run tests with a headless shell script (no UI)
     - `test:e2e:dev`: Build and run tests against a static server
   - Updated root-level e2e test scripts to monorepo's `package.json` to use headless mode by default
   - Added corresponding tasks to `turbo.json`

4. **Configuration**
   - Updated import paths in `global-setup.ts`
   - Fixed linting issues in the e2e test files
   - Added caching configuration for Turborepo
   - Configured server auto-detection to work with the default port (3000)
   - Set headless mode to true by default in Playwright config

## Why Use Shell Scripts?

We use shell scripts (`direct-playwright.sh` and `direct-playwright-headless.sh`) for several important reasons:

1. **Process Management**: The scripts handle starting and stopping the development server automatically, ensuring a clean environment each time.

2. **Coordination Problem**: In a Turborepo monorepo, the standard task execution can have timing issues between the webserver startup and test execution. The shell script provides better coordination.

3. **Environment Variable Control**: The scripts properly set environment variables needed for testing.

4. **Resource Cleanup**: They ensure proper cleanup of processes after tests finish, preventing orphaned processes.

5. **Reproducibility**: They create a more consistent testing environment that works the same way locally and in CI.

## Previous vs Current Testing Flow

### Previous Flow
```
# At project root
npm run test:e2e
```

### Current Flow

**Option 1: Headless Mode (No Browser UI) - Recommended for CI**
```bash
# From the root (uses the headless script)
npm run test:e2e

# Or from the web app directory
cd apps/web
npm run test:e2e:headless
```

**Option 2: Interactive Mode (For Debugging)**
```bash
# From the root
npm run test:e2e:sh

# Or from the web app directory
cd apps/web
npm run test:e2e:sh
```

**Option 3: Using Turborepo Directly**
```bash
# From the root
npm run test:e2e:turbo
```

## Troubleshooting

If you encounter issues with the new e2e testing setup, refer to the `README.md` file in the `apps/web/e2e` directory for common issues and their solutions.

The most reliable way to run the tests for CI or automation is the headless script:
```bash
npm run test:e2e
```

## Next Steps

- Consider adding GitHub Actions workflow for running e2e tests in CI
- Look into generating test reports and screenshots
- Set up visual regression testing if needed 