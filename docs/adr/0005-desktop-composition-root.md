# ADR-0005: Extract desktop composition before considering Layers

- **Status:** Accepted by owner (2026-09-25 UTC)
- **Context:** ADR-0004 reserves desktop main's composition root for its own
  decision. Evidence: `docs/agents/effect-boundary/desktop-composition-root.md`.

## Context

Desktop `main.ts` spans pre-ready Electron setup, module-scope IPC and host
managers, app-ready services, profile replacement, and process shutdown. Phase 3
kept graceful shutdown in a named, dependency-ordered sequence and factory reset
in parallel restartable stops. Neither operation follows reverse acquisition
order. Early IPC also reaches some app-ready services through lazy resolvers.
Wrapping the current managers in Layers would retain those lifecycles while
adding a second resource vocabulary.

## Decision

Extract a small, explicit **imperative composition owner first**, in independently
reviewable, behavior-preserving changes. Preserve pre-ready ordering, IPC
registration/disposal, app-ready acquisition timing and lazy resolution, reset,
stale DB-client rejection, and the existing five-second shutdown owner. Keep
Promise-facing APIs and the current Effect boundary. Measure whether the
extraction removes actual ownership ambiguity and cleanup duplication.

Do not make a whole-main Layer graph the default destination. A scoped Effect
owner needs a separate decision supported by a concrete acquisition/release
benefit, pinned-v4 API verification, tests, and bundle measurements. A wrapper
that merely constructs the same managers does not qualify.

Startup partial-acquisition cleanup and reset behavior after DB-owner retirement
are **separate behavior decisions**. Extraction must not silently add rollback,
publish a retired profile, or change the existing reset outcome rules. This ADR
was accepted by the owner as the basis for Phase 4 implementation.

## Alternatives

- **Selective Layers from the start:** possible for an isolated owner, but the
  ownership boundaries and failure behavior are not yet explicit enough to
  show a gain. Git and forge have separate failure-isolated shutdown steps.
- **One Layer graph for all of main:** would still need separate pre-ready,
  early IPC, restartable reset and ordered-shutdown coordination, with a much
  larger review surface.

## Validation for a later implementation

Each extraction PR must preserve existing tests and current observable behavior.
Review boot/IPC order, stale-handle behavior, reset/recovery, and failure-isolated
shutdown under the existing 5-second budget. Add focused characterization tests
before moving wiring, then compare actual dependency edges, mutable owner slots,
cleanup paths, and built bundles; do not set invented numerical targets.
