# pg_stat counters read zero until flushed — evidence

Supports `docs/agents/agent-self-query.md` § "⚠️ Statistics counters read ZERO until they are flushed".
Read before interpreting any `pg_stat_*` reading taken through the sandbox. Extracted verbatim from the pre-distillation contract.

**This is a trap, and the failure mode is a confidently wrong answer rather than
an error.** PostgreSQL accumulates stats per backend and flushes them
periodically; in PGlite's single-connection WASM environment that flush does not
happen on its own within a session. Measured after a workload of 12 indexed
lookups and 2 sequential scans:

```sql
SELECT relname, seq_scan, idx_scan FROM pg_stat_user_tables;   -- t, 0, 0   ← wrong
SELECT pg_stat_force_next_flush();                             -- allowed in the sandbox
SELECT relname, seq_scan, idx_scan FROM pg_stat_user_tables;   -- t, 2, 12  ← correct
```

`track_counts` is `on`, so the data is real — it is just unflushed. An agent that
skips the flush will read all-zeros and conclude "no index is ever used", which
is exactly the kind of silent wrongness this codebase forbids. **Always call
`SELECT pg_stat_force_next_flush()` before reading any `pg_stat_*` view.** It
works under the restricted role inside the read-only transaction (it is a stats
flush, not a data write).
