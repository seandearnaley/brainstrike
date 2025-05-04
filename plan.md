# Migration Plan (v0)

## Executive Summary
This migration plan outlines the stepwise extraction of UI components, React hooks, and utility functions from the `apps/web` application into canonical Turborepo packages (`packages/ui`, `packages/hooks`, `packages/utils`, `packages/types`). The objective is to enable robust code sharing between the web app and future Electron renderer, maximize tree-shaking and type safety, and ensure all code is independently testable and maintainable. Each migration task is atomic, independent, and limited in scope to ≤15 minutes and ≤30 lines per file. The plan includes updating all imports, mocks, and dynamic imports, moving and adapting unit tests, and verifying the absence of lingering references before staged deletion of old files. Build, type-check, and test steps are included throughout to ensure a smooth, error-free transition.

## Task List
| ID    | Action                                                                 | Files                                            | Cursor Cmds                          | Exit Criteria                    |
|-------|------------------------------------------------------------------------|--------------------------------------------------|--------------------------------------|----------------------------------|
| PRE-01| Enumerate all components, hooks, and utils for migration               | `apps/web/src/components/`, `hooks/`, `utils/`   | `list_dir`                           | List of files to migrate exists  |
| UI-01 | Move `Button` component to UI package, update export                   | `apps/web/src/components/Button.tsx` → `packages/ui/src/button.tsx`<br>`packages/ui/src/index.ts` | `move_file`, `edit_file`             | Button available from `@brainstrike/ui` |
| UI-02 | Move `Button` tests, update imports and matchers                       | `apps/web/src/components/__tests__/Button.test.tsx` → `packages/ui/src/__tests__/button.test.tsx` | `move_file`, `edit_file`             | Tests pass in new location       |
| UI-03 | Update all imports of `Button` to use UI package                       | All files importing `Button`                     | `grep_search`, `edit_file`           | No local imports remain          |
| UI-04 | Remove local `Button` file after confirming no references              | `apps/web/src/components/Button.tsx`             | `grep_search`, `edit_file`           | File deleted, build/test pass    |
| HK-01 | Move `use-file-tree` hook to hooks package, update export              | `apps/web/src/hooks/use-file-tree.ts` → `packages/hooks/src/use-file-tree.ts`<br>`packages/hooks/src/index.ts` | `move_file`, `edit_file`             | Hook available from `@brainstrike/hooks` |
| HK-02 | Move `use-file-tree` tests, update imports                             | `apps/web/src/hooks/__tests__/use-file-tree.test.ts` → `packages/hooks/src/__tests__/use-file-tree.test.ts` | `move_file`, `edit_file`             | Tests pass in new location       |
| HK-03 | Update all imports of `use-file-tree` to use hooks package             | All files importing `use-file-tree`              | `grep_search`, `edit_file`           | No local imports remain          |
| HK-04 | Remove local `use-file-tree` file after confirming no references       | `apps/web/src/hooks/use-file-tree.ts`            | `grep_search`, `edit_file`           | File deleted, build/test pass    |
| UT-01 | Move `file-selection-utils` to utils package, update export            | `apps/web/src/utils/file-selection-utils.ts` → `packages/utils/src/file-selection-utils.ts`<br>`packages/utils/src/index.ts` | `move_file`, `edit_file`             | Util available from `@brainstrike/utils` |
| UT-02 | Move `file-selection-utils` tests, update imports                      | `apps/web/src/utils/__tests__/file-selection-utils.test.ts` → `packages/utils/src/__tests__/file-selection-utils.test.ts` | `move_file`, `edit_file`             | Tests pass in new location       |
| UT-03 | Update all imports of `file-selection-utils` to use utils package      | All files importing `file-selection-utils`        | `grep_search`, `edit_file`           | No local imports remain          |
| UT-04 | Remove local `file-selection-utils` file after confirming no references| `apps/web/src/utils/file-selection-utils.ts`      | `grep_search`, `edit_file`           | File deleted, build/test pass    |
| CONF-01 | Update package exports, tsconfig, and build config for new modules   | `packages/ui/package.json`, `tsconfig.json`, etc. | `edit_file`                          | Packages build and type-check    |
| TEST-01 | Run full build, type-check, and tests across all workspaces          | All packages and apps                            | `run_command`                        | All checks green                 |

```

**Notes:**
- Replace `Button`, `use-file-tree`, `file-selection-utils` with actual file names after PRE-01.
- Each "move" is paired with updating tests and imports, then deletion after confirming no references.
- All file paths are relative.
- Each task is atomic and independent.
- Unit-test insertion/migration is included for each code move.
- Build, type-check, and test tasks are included at the end and after each deletion.
