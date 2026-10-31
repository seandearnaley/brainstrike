# @brainstrike/assistant-data

Renderer-safe data contracts, thread/group/workspace helpers and usage/cost projections. Depends on contract layers, never on app-shell or UI.

- Root exports are routed by [`index.ts`](src/index.ts); subpaths are in [`package.json`](package.json).
  - `/cost-tracking`: daily-spend and run-ledger hooks.
  - `/model-pricing`: model pricing.
- Not a transcript writer: desktop conversations, run outcomes and workspace authority belong to the committed host log ([persistence](../../docs/agents/assistant-persistence.md)).
- Preserve canonical resource/thread identity. Provider-reported cost is authoritative; client estimates stay estimates.
