# File Explorer Configuration Dialog

This popout dialog lets users configure File Explorer behavior (filters, regex, include project tree, thresholds, selection caps). It uses a draft state while the dialog is open and persists via the underlying Zustand store on apply.

Key design points:

- Single Source of Truth: The dialog reads values from the rehydrated store selectors when opened. We do not overlay stale localStorage snapshots.
- Draft vs. Persisted:
  - Inputs update a local `settings` object immediately via `onSettingsChange`.
  - The file extension filter propagates draft changes instantly to keep UX in sync and debounces heavy `onFilterChange` effects.
- Persistence on Apply:
  - We call store actions (e.g., `setFilters`, `setMaxSelectionCount`) and then patch the persisted state via the store’s `persist.storage` (worker/localStorage) to avoid timing races on immediate reloads.
  - A short (~50ms) delay before closing the dialog improves durability across fast reloads.
- Clamping:
  - Max Selection Count is clamped to `[MIN_MAX_SELECTION_COUNT, MAX_SELECTION_COUNT]`.
  - Folder Summary Threshold is clamped to `[MIN_FOLDER_SUMMARY_THRESHOLD, MAX_FOLDER_SUMMARY_THRESHOLD]`.
  - The store trims the selection set if the max is reduced below the current selection size.

Testing:

- E2E coverage in `apps/web/e2e` validates persistence for each control and clamping behavior.
- Store action unit tests validate clamping and trimming logic.

