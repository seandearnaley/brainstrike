# ADR-0005: Extract desktop composition before considering Layers

- **Status:** Accepted by owner (2026-09-25 UTC) as the basis for Phase 4.
  - The "five-second shutdown owner" below was replaced by a joined quit with no global
    deadline ([ADR-0026](0026-lifecycle-readiness-liveness-joined-quit.md) R4,
    [ADR-0027](0027-canonical-electron-quit.md)).
- **Context:** ADR-0004 reserves desktop main's composition root for its own decision. (Its
  evidence file under `docs/archive/` is no longer in the repo.)

## Context

- Desktop `main.ts` spans pre-ready Electron setup, module-scope IPC and host managers,
  app-ready services, profile replacement and process shutdown.
- Phase 3 kept graceful shutdown as a named, dependency-ordered sequence and factory reset as
  parallel restartable stops. Neither follows reverse acquisition order.
- Early IPC reaches some app-ready services through lazy resolvers.
- Wrapping today's managers in Layers would keep those lifecycles and add a second resource
  vocabulary.

## Decision

- **Extract a small, explicit imperative composition owner first**, in independently
  reviewable, behaviour-preserving changes.
  - Preserve: pre-ready ordering, IPC registration/disposal, app-ready acquisition timing and
    lazy resolution, reset, stale DB-client rejection, and the then-current five-second
    shutdown owner.
  - Keep Promise-facing APIs and the current Effect boundary.
  - Measure whether extraction removes real ownership ambiguity and cleanup duplication.
- **A whole-main Layer graph is not the default destination.** A scoped Effect owner needs its
  own decision, backed by a concrete acquisition/release benefit, pinned-v4 API verification,
  tests and bundle measurements. A wrapper that only constructs the same managers does not
  qualify.
- **Separate behaviour decisions:** startup partial-acquisition cleanup, and reset behaviour after
  DB-owner retirement. Extraction must not silently add rollback, publish a retired profile, or
  change reset outcome rules.

## Alternatives

- **Selective Layers from the start:** possible for an isolated owner, but ownership boundaries
  and failure behaviour were not explicit enough to show a gain.
- **One Layer graph for all of main:** still needs separate pre-ready, early-IPC, restartable
  reset and ordered-shutdown coordination, with a much larger review surface.

## Validation for a later implementation

- Each extraction PR preserves existing tests and observable behaviour.
- Review boot/IPC order, stale-handle behaviour, reset/recovery and failure-isolated shutdown under the then-current 5-second budget.
- Add focused characterization tests before moving wiring.
- Compare dependency edges, mutable owner slots, cleanup paths and built bundles; set no invented
  numerical targets.
