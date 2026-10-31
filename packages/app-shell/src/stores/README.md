# App-shell session stores

Session-lived Zustand stores for transient UI intent and observation; none are persisted.

- `command-palette-store.ts`: open state and the target/tab scope captured when the palette opens.
- `on-screen-thread-store.ts`: the transcript actually visible in this window. Restoring an on-screen thread ID must not mark a run seen before its transcript is displayed.
- `terminal-target-store.ts`: the checkout requested by another surface.
- `worktree-checkout-intent-store.ts`: a one-shot request consumed by the existing checkout writer.

UI intent is never a durable thread or workspace authority. Persistent preferences and layout belong to [`@brainstrike/app-state`](../../../app-state/README.md); new durable state joins reset.
