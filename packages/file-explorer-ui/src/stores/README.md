# Explorer presentation stores

Persisted stores keep lightweight UI metadata, never file bytes or runtime grants.

- Persisted:
  - `tab-manager-store.ts`: open file-tab identities/paths and the active tab. Hydration clears content, loading and error state.
  - `editor-view-state-store.ts`: per-file scroll, selection and view mode.
  - `workspace-tab-selection-store.ts`: application/tab selection, including an intentionally empty open set. Activation and hydration state stay transient.
- Session-only:
  - `file-tab-pane-store.ts`. The per-thread workspace snapshot owner already persists pane state; persisting it here would add a second writer that fights hydration.
- Storage failures stay visible through the existing storage helpers; an SSR/test memory store is not proof of durable writes.
- New persistent state joins reset. See [workspace context](../../../../docs/agents/workspace-context.md).
