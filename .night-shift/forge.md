## Responsive Explorer E2E helpers must follow visible action surfaces

**Learning:** The Web Explorer moves view-filter actions from a direct toolbar toggle into the `More Explorer actions` menu below its compact breakpoint, while keeping distinct accessible names for both surfaces.
**Action:** E2E helpers that operate responsive Explorer actions should prefer the visible direct control, then use the compact menu's named action, and assert the resulting panel state without widening the viewport or adding retries.
