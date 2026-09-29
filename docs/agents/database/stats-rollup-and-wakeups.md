# Stats rollup and wakeup polling — evidence

Supports `docs/agents/database.md` § "STATS ROLLUP + WAKEUP POLLING".

The load-bearing facts behind keeping `collection_indexing_stats` a hand-maintained rollup and wakeups on live queries plus bounded polling. Settled 2026-07; full rationale and revisit conditions in `docs/db-rollup-and-wakeup-modernization-decision-2026-07.md`.

The record below is the original contract text, extracted unchanged.

`collection_indexing_stats` stays a hand-maintained rollup table (NOT a
materialized view), and queue wakeups / cross-tab invalidation stay on
`live` queries + bounded interval polling (NO raw LISTEN/NOTIFY layer).
Load-bearing facts: PGlite `live` queries throw at subscribe time on
matviews (triggers are forbidden on them), `REFRESH` is an unbounded
all-collections recompute on the single connection, the `dirty` /
`last_refreshed_at` columns are a reader contract (#1115), and `live` is
itself trigger+pg_notify under the hood — a raw NOTIFY channel would
duplicate it while feeding burst wakeups into the #1247-hardened
scheduling layers. Full rationale, revisit conditions, and verification
probes: `docs/db-rollup-and-wakeup-modernization-decision-2026-07.md`.
