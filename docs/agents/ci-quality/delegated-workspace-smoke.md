# Delegated workspace smoke — evidence

Supports `docs/agents/ci-quality.md` § "Delegated workspace smoke coverage"
(BST-1762). Read this when the delegated desktop smoke lane's duration or
deadline is in question. These are observed totals, not a before/after delta.

The required delegated desktop smoke lane (`test:e2e:lane:smoke-delegated`,
BST-1762) includes `delegated-workspace-reload.desktop.test.ts` and its `@smoke`
case. It restores two native child histories through the real workspace
coordinator, switches by keyboard, closes a sibling tab, and verifies that
inspection neither executes inference nor advertises unsupported edit/regenerate
actions. Its screenshot uses disabled finite animations for stable evidence. The
case measured 4.2s locally (not the complete lane). On head bf8d50b, required
Desktop E2E job 103119913725 completed in 6m19s including setup and this new
smoke case. This is an observed total, not a measured before/after lane delta.
The existing lane deadline and zero-retry policy remain unchanged.
