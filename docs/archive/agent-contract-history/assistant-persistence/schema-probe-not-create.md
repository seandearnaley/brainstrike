# The retired bootstrap mirror and the schema probe — evidence

Supports `docs/agents/assistant-persistence.md` §
"The repository PROBES; it never creates". Read this before proposing to change the to_regclass probe or its memoization.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

`createPgliteAssistantThreadRepository` used to `exec` a ~590-line
`CREATE TABLE IF NOT EXISTS` mirror of migrations 046-095 on first use per
handle. The mirror was required to stay byte-identical to those migrations by
hand, and **nothing could observe a violation**: on a migrated database the
`IF NOT EXISTS` never fires, so a divergence stayed invisible until a user hit a
column the two had shaped differently. Retiring it found one that had already
shipped — `brainstrike_assistant_tool_projection_rewrites` had `kind` at ordinal
5 on a bootstrapped database and ordinal 8 on a migrated one, because migration
084 creates the table and 087 ADDs the column.

The replacement is a `to_regclass` probe over every relation the repository
reads or writes (the explicit run tables plus every entry of
`THREAD_DELETE_SIDECAR_TABLES`, which the thread-delete cascade references
unconditionally), memoized per handle in the
`assistantThreadSchemaProbePromises` WeakMap and awaited by every repository
method. A missing relation throws `AssistantMemorySchemaMissingError` naming it.

- `to_regclass` ONLY — it returns NULL for an absent relation instead of raising,
  so one statement answers for the whole set.
- **No `IF NOT EXISTS`, no catch-and-create, no create-if-missing fallback.** A
  missing relation means migrations did not run. Creating it quietly is exactly
  how the divergence above was manufactured.
- A FAILED probe drops its memo so the handle re-probes; only success is cached.
- Additive statements that used to reach old installs through the bootstrap's
  per-init re-run now live in migration 118: `thread_runs.turn_message_id`
  (`ADD COLUMN IF NOT EXISTS`, BST-1163), the two partial approval indexes, and
  the `DROP INDEX IF EXISTS` of the pre-BST-1440 `…_approval_answer_idx`.

