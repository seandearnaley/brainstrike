# Self-improvement signal injection — evidence

Supports `docs/agents/workspace-context.md` §
"SELF-IMPROVEMENT SIGNAL INJECTION".
Read before changing the 24-hour waste summary injector, its SQL ownership, or the companion experiment-enrollment preference.

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

## Record

Desktop can prepend a compact summary of the previous 24 hours' wasteful tool
behavior to each fresh assistant run. This is an explicit persisted opt-in and
defaults OFF. The renderer attaches `{ enabled }` as plain JSON; the server
strictly parses it with malformed input failing safe to OFF.

- **SQL ownership:** injection executes the app-owned
  `SELF_IMPROVEMENT_SIGNAL_SQL` constant, never a workspace-scanned lens. A
  mounted repository can shadow `.brainstrike/lenses/self-improvement-signal.sql`;
  executing that untrusted copy automatically would let repository-authored SQL
  shape a system message. The parity test parses the shipped repository lens and
  pins its SQL body byte-equal to the app-owned constant so the reviewed query
  and injection query cannot drift.
- **Position and scope:** `resolveInitialAgentStream` applies the injector only
  on the fresh-generation path, between explicit skill activation and workspace
  instructions. Because every injector prepends, final context order is
  workspace instructions → self-improvement signal → activated skills →
  referenced files → conversation. Approval and resume legs retain their early
  returns and never re-inject it. Provider `local` is excluded to protect its
  small context budget.
- **Untrusted DATA hardening (distinct from SQL ownership):** telemetry
  `tool_id` is persisted VERBATIM from the original tool name, and MCP servers
  choose arbitrary strings — so the query's *rows* are an untrusted channel
  even though its *SQL* is app-owned. Rendering restricts each id to
  `[A-Za-z0-9_.:-]` (rest → `_`) capped at 40 chars, so a hostile name can
  neither smuggle newline/instruction-shaped text into the system message nor
  inflate the prompt. Worst-case whole-block size is structural (id cap ×
  top-5), pinned < 750 chars by test — there is no runtime truncation path.
- **Latency + prompt-cache posture:** the 24h window anchors to the top of the
  hour and the parsed rows are memoized per hour-key in main. One sandboxed
  query per hour per process (the admit `EXPLAIN` + execute pair stays off the
  per-run path of the single-connection PGlite, where `statement_timeout` is
  inert), and the rendered block is byte-stable within the hour, so the
  provider's cached prompt prefix (BST-587 invariant) is invalidated at most
  hourly. Failures are NOT memoized — the next run retries; an empty no-waste
  hour IS memoized so it cannot re-query per run.
- **Failure posture:** query failure, malformed rows, or an unexpected column
  contract logs a warning and injects nothing; zero qualifying waste logs at
  debug. It never injects stale, fabricated, or guessed text, and every no-op
  preserves the original message-array identity.
- **Measurement/removal protocol:** compare equivalent before/after windows with
  both the `run-outcome-tool-correlation` and `self-improvement-signal` lenses,
  following the comparable-window method in
  [`docs/tool-token-efficiency-2026-08-07/BASELINE.md`](../tool-token-efficiency-2026-08-07/BASELINE.md).
  After a meaningful sample, remove the feature if truncation and zero-match
  rates do not improve.

The companion experiment-enrollment preference (BST-1251, phase 2B) rides the
same renderer seam: a persisted `{ experimentId, variant }` pair (defaults
null = un-enrolled, factory-reset to null) attached as
`experimentAssignment` only when BOTH fields are set — the contract requires
the pair jointly, and the server strictly parses it onto the run's treatment
row (see `docs/agents/assistant-persistence.md`). Enrollment is attribution
metadata only; it never changes runtime behavior.

Paired tests: `apps/desktop/src/__tests__/assistant-server/self-improvement-signal-context.test.ts`
(preference, provider, query/column/row failure posture, exact prompt, size, and
SQL parity),
`packages/app-state/src/__tests__/factory-reset-self-improvement-signal-preferences.test.ts`,
`packages/app-state/src/__tests__/experiment-assignment-preferences-store.test.ts`,
`packages/app-state/src/__tests__/factory-reset-experiment-assignment.test.ts`,
`packages/settings-ui/src/__tests__/self-improvement-signal-settings-section.test.tsx`,
`packages/settings-ui/src/__tests__/experiment-assignment-settings-section.test.tsx`,
and `packages/app-shell/src/__tests__/assistant-ui-panel-wrapper-runtime.test.ts`.

