# App-shell session stores

These local Zustand stores hold transient UI intent and observation:

- `command-palette-store.ts`: open state and the target/tab scope captured when
  the palette opens.
- `quick-open-store.ts`: file-finder open/close state.
- `on-screen-thread-store.ts`: the transcript actually visible in this window.
- `terminal-target-store.ts`: the checkout requested by another surface.
- `worktree-checkout-intent-store.ts`: a one-shot request consumed by the existing
  checkout writer.

They are session-lived and not persisted. In particular, restoring an on-screen
thread ID must not mark a run seen before its transcript is displayed. UI intent
is not a second durable thread/workspace authority.

Persistent preferences/layout state belongs to
[`@brainstrike/app-state`](../../../app-state/README.md) and its explicit subpaths;
new durable state participates in reset. The former DB-panel/import/vector store
inventory in this directory's README described removed or relocated files.

Use each store's current selectors/actions and the existing session drain/reset
owner. Source and package configuration define test helpers and public exports.
