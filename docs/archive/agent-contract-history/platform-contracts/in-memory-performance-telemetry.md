# Session-only performance snapshots — evidence

Supports `docs/agents/platform-contracts.md` § "IN-MEMORY PERFORMANCE TELEMETRY".
Read before persisting or exporting a renderer long-task, embedding-runtime, or database-query snapshot. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
Renderer long-task, embedding-runtime, and database-query performance snapshots are
session-only diagnostics. They are deliberately not written to the diagnostic-event
table, local storage, IndexedDB, or filesystem, so they require no factory-reset wiring.
Embedding worker measurements are source-scoped and removed when their worker terminates.
The bounded telemetry-health failure count and last reason are session-latched so a lost
diagnostic remains visible after source cleanup; renderer restart clears them. Desktop main
only relays the hidden renderer's validated snapshot. Persisting or exporting any
of these snapshots is a contract change: update the diagnostics privacy contract and add
the persistence to every applicable factory-reset path in the same change.
