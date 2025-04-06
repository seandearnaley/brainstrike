# Next.js to Vite Migration Summary

This document summarizes the completed migration from Next.js to Vite, with a particular focus on the testing infrastructure changes.

## Migration Overview & Status

The migration from Next.js to Vite is complete. Key infrastructure changes included:

- ✅ Vite configuration established (`vite.config.mts`).
- ✅ Project entry point updated (`index.html` and `src/main.tsx`).
- ✅ Vitest test runner integrated, replacing Jest (`vite.config.mts`).
- ✅ Vitest setup file created and configured (`src/test/vitest.setup.ts`).
- ✅ Test utilities and mocks updated to work with Vitest.
- ✅ All test files migrated from Jest to Vitest syntax, leveraging an automated script and manual verification.
- ✅ Build configuration finalized for production builds via Vite.
- ✅ Routing handled via [React Router/Client-side logic - *confirm and update*].
- ✅ Environment variables updated to use the `VITE_` prefix.
- ✅ Metadata/document handling updated (e.g., using standard title tags instead of Next.js metadata API).
- ✅ Static export confirmed to work with Vite's build output.
- ✅ Next.js dependencies and specific configurations removed.
- ✅ Relevant documentation updated.

## Key Migration Tasks Performed

1.  **Test Framework Migration:**
    *   Replaced Jest with Vitest.
    *   Updated test configurations, setup files, and utilities.
    *   Migrated test syntax using an automated script and manual review.
    *   Ensured test coverage and functionality were maintained.

2.  **Build System Replacement:**
    *   Replaced Next.js build system with Vite.
    *   Configured Vite for development (`npm run dev`) and production builds (`npm run build`).
    *   Ensured static assets and code splitting work correctly.

3. **Routing:**
   *   Removed Next.js App Router.
   *   Implemented client-side routing [using React Router/other method - *confirm and update*].

4. **Environment Variables:**
   *   Switched from `NEXT_PUBLIC_` prefix to `VITE_`.
   *   Updated access method from `process.env` to `import.meta.env`.

5. **Core API/Feature Replacement:**
   *   Replaced Next.js specific APIs (like metadata) with framework-agnostic solutions or standard browser APIs.

6. **Dependency & Configuration Cleanup:**
   *   Removed `next` package and related dependencies (e.g., `@types/next`).
   *   Deleted Next.js configuration files (e.g., `next.config.js`).
   *   Cleaned up `.gitignore`, `.vercelignore`, etc.

## Automated Test Migration Details

An automated migration script (`scripts/migrate-tests-to-vitest.js`) was used to handle common Jest to Vitest conversions across the test suite. This script performed tasks such as:

- Converting Jest imports (`@jest/globals`) to Vitest imports (`vitest`).
- Replacing Jest API calls (`jest.fn`, `jest.mock`, `jest.useFakeTimers`, etc.) with their Vitest equivalents (`vi.fn`, `vi.mock`, `vi.useFakeTimers`, etc.).
- Adding necessary Vitest imports.
- Creating backups of original files.
- Formatting modified files using Biome.

After the automated run, manual verification and adjustments were performed to fix any remaining issues, particularly in complex tests or mocks.

## Resources

- [Jest to Vitest Migration Guide](./jest-vitest-migration.md) - Detailed instructions for migrating tests
- [Vitest Documentation](https://vitest.dev/) - Official Vitest documentation
- [Vite Documentation](https://vitejs.dev/) - Official Vite documentation 