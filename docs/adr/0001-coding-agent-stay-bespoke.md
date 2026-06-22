# ADR-0001: Coding-agent capabilities — stay bespoke, replicate patterns

- **Status:** Accepted
- **Date:** 2026-06-19
- **Context source:** reverse-engineering of `mastra-ai/mastra-code-ui`
  (see `docs/mastra-code-port-breakdown-2026-06-19.md` + `...-synthesis-2026-06-19.md`).

## Context

We are turning brainstrike's read-only RAG assistant into a full coding agent by porting
capabilities demonstrated by `mastra-code-ui`. That app is a **thin Electron shell over the
published `mastracode` + `@mastra/core/harness` + `@mastra/memory` + `@mastra/libsql`
packages** — it *calls* a fully-wired Harness rather than owning the agent loop.

brainstrike instead **owns** its loop (`createMastraAgentRuntime`), its observational memory
(`pglite-mastra-memory`), its tool guards, and its PGlite/pgvector store. It imports none of
the Harness/mastracode/libsql.

The decision: adopt the Harness wholesale, or keep the bespoke loop and replicate patterns?

## Decision

**Stay bespoke. Replicate mastra-code's *patterns* (not its code). Never import
`@mastra/core/harness`, `mastracode`, or `@mastra/libsql`.**

## Rationale

1. **LibSQL is Node-only → kills the web surface.** `@libsql/client` cannot run in the web
   renderer. brainstrike is web+desktop by mandate; the Harness's storage and IPC event bus
   are desktop-only by construction. Our HTTP/SSE `DataStreamMapper` already serves both.
2. **Version divergence.** brainstrike is on `@mastra/core@^1.37.1`; mastra-code's Harness is
   `1.9.0` — a different, older API line. Adoption is not a version bump but a product swap.
3. **Vendored-internals fragility.** mastra-code had to `pnpm-patch` minified `mastracode`
   dist to fix an OAuth header bug. "Own your loop / no silent fallbacks" is the opposite
   stance; we will not patch a vendored agent bundle.
4. **We already own better-suited seams.** `createMastraAgentRuntime`, three live resilience
   layers, a typed + secret-redacted run-event taxonomy, snapshot-grouping reload hydration,
   and a DB-backed model catalog — all web-capable. Adopting the Harness means deleting
   working, tested infrastructure for a desktop-only black box.
5. **Single-cwd model mismatch.** The Harness assumes one-Harness-per-worktree; brainstrike is
   multi-root-in-one-renderer with durable `rootId` identity.

## Consequences

- Each ported feature is **net-new work in brainstrike's existing registries/seams**, not a
  copy-paste. The multi-registry tool contract, LIVE-loop test mandate, capability-gating, and
  no-silent-fallbacks invariants apply to every port.
- We name and harden the existing **brainstrike agent event bus** (run-events +
  `DataStreamMapper` + assistant-server) as the connective tissue; new coding-agent event
  kinds (`subagent.*`, `plan.approval.*`, `ask.question.*`, `shell.output`, `hook.*`) extend
  this single union and must ship with hydration fixtures from real persisted rows.
- The `@mastra/libsql` data-layer split is a **separate, measured decision** (see plan
  Phase 0.3), not a precondition.
- Execution follows `docs/coding-agent-pr-plan-2026-06-19.md`: permission engine before any
  mutating tool; edit+shell before subagents; data-layer decided (not built) up front; OAuth
  gated behind legal review.

## Differentiators this unlocks (that the Harness structurally cannot)

- **RAG-grounded edits** — re-index edited files via `job_queue` so semantic search never goes
  stale (mastra-code has no index).
- **Web + desktop coding agent** — FS-Access writes + HTTP/SSE event bus.
- **Local-first, keyless** — chat, OM, and embeddings on the built-in Gemma host.
