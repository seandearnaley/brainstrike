# ADR-0001: Coding-agent capabilities — stay bespoke, replicate patterns

- **Status:** Accepted. Superseded in part:
  - The loop is now one AI SDK `streamText` loop per run, with Mastra only as a memory library
    ([ADR-0012](0012-ai-sdk-loop-mastra-memory-library.md)).
  - Storage moved from PGlite/pgvector to SQLite ([ADR-0011](0011-run-log-and-state-store.md),
    [ADR-0018](0018-derived-sqlite-indexer.md)); the web app and `job_queue` are gone.
  - The core rule still holds: never import `@mastra/core/harness`, `mastracode` or
    `@mastra/libsql`.
- **Date:** 2026-06-19
- **Context source:** reverse-engineering of `mastra-ai/mastra-code-ui` (2026-06-19 port
  breakdown and synthesis; no longer in the repo).

## Context

We were turning Brainstrike's read-only RAG assistant into a coding agent by porting
capabilities from `mastra-code-ui`.

- `mastra-code-ui` is a thin Electron shell over `mastracode`, `@mastra/core/harness`,
  `@mastra/memory` and `@mastra/libsql`. It calls a fully wired Harness rather than owning a
  loop.
- Brainstrike owned its loop, observational memory, tool guards and store, and imported none of
  those packages.
- Question: adopt the Harness wholesale, or keep the bespoke loop and replicate patterns?

## Decision

Stay bespoke. Replicate mastra-code's patterns, not its code. Never import
`@mastra/core/harness`, `mastracode` or `@mastra/libsql`.

## Rationale

1. **LibSQL was Node-only**, which would have killed the then-planned web surface; the Harness's
   storage and IPC bus are desktop-only by construction.
2. **Version divergence:** Brainstrike was on `@mastra/core@^1.37.1`, the Harness on `1.9.0`.
   Adoption would be a product swap, not a bump.
3. **Vendored-internals fragility:** mastra-code had to patch minified `mastracode` dist for an
   OAuth bug. We will not patch a vendored agent bundle.
4. **We already owned better seams:** the runtime, resilience layers, a typed and redacted
   run-event taxonomy, reload hydration and a model catalog.
5. **Single-cwd mismatch:** the Harness assumes one Harness per worktree; Brainstrike is
   multi-root with durable `rootId` identity.

## Consequences

- Each ported feature is new work in Brainstrike's own registries and seams. The tool contract,
  live-loop tests, capability gating and no-silent-fallbacks rules apply to every port.
- New coding-agent event kinds (`subagent.*`, `plan.approval.*`, `ask.question.*`,
  `shell.output`, `hook.*`) extend the single run-event union and ship with hydration fixtures
  from real persisted rows.
- Execution order at the time: permission engine before any mutating tool; edit + shell before
  subagents; OAuth gated behind legal review.
- Differentiators the Harness could not offer: index-grounded edits (edited files re-indexed so
  search never goes stale) and local-first, keyless operation.
