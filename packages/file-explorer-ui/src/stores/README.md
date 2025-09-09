# File Explorer UI Stores

Small Zustand stores that persist lightweight editor UI state:

- `editor-view-state-store.ts`: Scroll positions and simple selection ranges per composite key. Used by the tabbed editor to restore view state across unmounts/reloads.
- `editor-cursor-store.ts`: Cursor/selection model suitable for richer editors (Monaco/CodeMirror). Not yet wired to a full editor.
- `tab-manager-store.ts`: Canonical list of open tabs + active tab, with one-time migration from legacy `fileEditorTabs.v1`.

All stores use JSON storage that falls back to in-memory for SSR/tests.

