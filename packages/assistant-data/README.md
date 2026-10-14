# @brainstrike/assistant-data

Renderer-safe data contracts, thread/group/workspace helpers and usage/cost
projections. It depends on database/contract layers rather than app-shell or UI.

The root exports are routed by [`index.ts`](src/index.ts); `/cost-tracking` owns
daily-spend/run-ledger hooks and model pricing. Use the explicit subpath map in
[`package.json`](package.json), not an old inventory of auth or suspended-run APIs.

These shared repository surfaces do not establish a desktop transcript writer:
desktop conversations, run outcomes and workspace authority belong to the committed
host log. Preserve canonical resource/thread identity and provider-reported cost;
client estimates remain estimates. See
[persistence](../../docs/agents/assistant-persistence.md) and
[shared contribution/validation policy](../../AGENTS.md).
