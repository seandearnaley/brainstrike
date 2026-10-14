# Renderer sync-loop coordinator (BST-1775) — evidence

Supports `docs/agents/local-inference.md` § "Renderer sync-loop coordinator".
Read before moving sync-loop ownership back into the React tree or changing
generation invalidation. The contract holds the rules; this is the original
text.

## Original text

   - Renderer sync-loop ownership lives in the React-free
     `WorkspaceIndexingCoordinator` (BST-1775). The provider updates its current
     inputs and wires subscriptions; the coordinator owns trigger coalescing,
     generation invalidation, sequential multi-root execution, explicit cancel,
     and requester detach. A focus-only input update MUST NOT invalidate active
     work. A deliberate restart or stop increments the generation before the
     previous promise settles, and a stale generation's finalizer must not clear
     pending work owned by the replacement. Target resolution must check that
     generation after each await before reconciling roots or publishing status,
     and a restart waits for the cancellation sweep before starting replacement
     work. A completed sweep may report aggregated failures; report them and
     still start the requested replacement. Pause authority comes from the live
     arbiter boolean, never from whether its human-readable reason list is empty.
     Direct coordinator tests own those
     lifecycle rules; the mounted provider suite proves preference, arbiter,
     refresh-event, reset, and teardown wiring.
