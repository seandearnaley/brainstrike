# Native invocation identity — evidence

Supports `docs/agents/database.md` § "Native invocation identity".

Migrations 127/128: the immutable invocation key, bind/resume authorization, and usage attribution onto the root-attributed table. Read before changing invocation identity or host-run retention.

The record below is the original contract text, extracted unchanged.

Migration 127 adds `brainstrike_delegated_invocations`. Its immutable key is
root thread + observed native parent run + parent tool call. A conversation may
have multiple invocations; persona identity is never a substitute for either.
`createInvocation` requires an already authorized child graph node and a real
root host run row belonging to the same owner/root. It snapshots that row's
nonblank `turn_message_id`. The host leg id and native parent run id are separate:
Mastra mints its own run ids, and approval/suspension creates new host legs.

`bindInvocationRun` atomically checks the observed persona against the stored
invocation before recording the native child run. This applies to both the
initial bind and duplicate/resume authorization; a mismatch never changes the
record. The method records the observed native child run once; exact duplicate
delivery is idempotent and a different child run is rejected. A subsequent native delegation gets a
new invocation key and child run while retaining its conversation. Human idle
wakes use the separate continuation admission described above. Reads and
run binding revalidate the whole native ancestry and the original host row's
owner/root/turn. Desktop passes its current host leg into the same SQL mutation,
which rechecks the current owner/root/turn atomically; a stale preliminary scope
read cannot authorize a changed resume leg. Resume must read the existing
invocation, rather than create it with the resume leg id. No placeholder native run id is invented before the
first child stream chunk.

Current root host-run writers set `turn_message_id` only on insert; terminal
updates change status/error/timestamps. There is no age/count pruning of host
run rows today. The invocation FK cascades on explicit host-run deletion; a
future retention policy must retain these rows while descendants can resume,
or atomically delete the complete branch. It must not silently orphan resumable
identity. Reset helpers issue `DELETE`, not `TRUNCATE`, including the desktop
and both direct-PGlite paths. Multiple pending follow-ups rely on the UNIQUE
constraint's default NULLS DISTINCT semantics; a native child run cannot equal
its native parent run.

Desktop run-scoped memory activates this repository through server-owned host
capabilities. Migration 128 adds nullable parent-run/tool-call columns to the
existing root-attributed usage table, with an invocation FK and unique index.
Legacy rows remain NULL; the host never guesses historical child identity.
`recordInvocationUsage` requires authorized native ancestry, a bound child run,
matching child thread/resource/persona and matching original/current host turns.
It reconciles cumulative provider totals with monotonic maxima on one row;
model/provider changes reject instead of rewriting attribution. The existing
desktop stream writer is still the only child-usage producer, and awaits this
write before refreshing the renderer. Deleting an invocation sets only the two
delegation keys to NULL, retaining the root's already-spent tokens and cost.
Numeric usage history already survives root conversation deletion (the existing
thread-delete sidecar list excludes it); this migration preserves that behavior.
Factory reset clears the existing usage table. The column-specific SET NULL
uses the engine's documented [PostgreSQL 18 referential action](https://www.postgresql.org/docs/18/ddl-constraints.html#DDL-CONSTRAINTS-FK).
`delegated-invocations.integration.test.ts` verifies
ownership changes, duplicates, follow-ups, reconstruction in a new PGlite engine,
production-ledger upgrade/replay, and native-thread deletion cascades. All reset
paths clear the new table before its graph parent. The real Mastra contract test
binds each of two concurrent child invocations before inspecting its first
native event and verifies the separate host/root-turn/native identities.
