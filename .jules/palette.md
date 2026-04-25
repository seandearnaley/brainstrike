## 2024-05-18 - Missing Test Target
**Learning:** When running targeted tests with Vitest using `pnpm test <path>`, explicitly passing the source component file directly (e.g., `src/status-items/collection-sync-status-item.tsx`) will result in a 'No test files found' error and exit code 1.
**Action:** Always pass the path to the associated `.test.ts` or `.test.tsx` file instead.
