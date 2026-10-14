# Explorer presentation stores

Persisted stores keep lightweight UI metadata, not file bytes or runtime grants:

- `tab-manager-store.ts`: open file-tab identities/paths and active tab; hydration
  clears content/loading/error state. Existing legacy-key/version handling is
  implementation history, not a new migration obligation.
- `editor-view-state-store.ts` and `editor-cursor-store.ts`: per-file scroll and
  cursor/selection presentation.
- `inspector-view-store.ts`: context-specific inspector presentation.
- `workspace-tab-selection-store.ts`: application/tab selection, including an
  intentionally empty open set; transient activation/hydration state stays transient.

`file-tab-pane-store.ts` is session-only. Its durability is captured by the
existing per-thread workspace snapshot owner; persisting the same pane state here
would introduce a second writer that fights hydration.

Use the actual exported stores/actions and reset/hydration owners. Storage failure
policy comes from the existing storage helpers and must remain visible; an SSR/test
memory store is not proof of durable writes. New persistent state participates
in reset. See [workspace](../../../../docs/agents/workspace-context.md) and
[shared contribution/validation policy](../../../../AGENTS.md).
