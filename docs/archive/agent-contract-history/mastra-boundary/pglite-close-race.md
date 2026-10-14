# The PGlite close() race — evidence

Supports `docs/agents/mastra-boundary.md` § "Root cause: a PGlite `close()` race,
NOT an OM state leak". Read this before writing any PGlite close path, or when a
worker wedges with no timeout firing. The mechanism was instrumented on pglite
0.5.4 and re-confirmed on the pinned 0.5.5; upstream pglite#1084 and
mastra#21617 were open when this was written.



The earlier "state leaks across observation cycles" reading, and the
`getObservableMessages` / removed-`blockAfter` lead, are **both refuted**. What
actually happens was instrumented end to end (PGlite statement trace with
`close()` wrapped, plus a CDP pause + CPU profile of the wedged fork):

1. After a run's stream is consumed, `@mastra/core` fires its agentic-loop
   workflow-snapshot cleanup (`DELETE FROM mastra_workflow_snapshot WHERE
   workflow_name = $1 AND run_id = $2`) as **unawaited background work** — the
   caller gets no join point for it.
2. The spec's `afterEach` then calls `await database.close()`.
3. `PGlite.close()` calls `mod._pgl_setPGliteActive(0)` — deactivating the WASM
   backend — **before** it awaits the shutdown protocol and `closeFs()`.
   `_checkReady()` only guards *entry*, so a statement already past that guard
   enters `execProtocolRawSync`'s **synchronous** main loop against a dead
   backend and never returns. Neither the statement nor `close()` ever settles.

**Versions, stated exactly.** The vitest statement trace and CPU profile below
were captured on `@electric-sql/pglite` **0.5.4**, on the BST-1282 branch before
BST-1283 bumped the catalog. This repo now pins **0.5.5**
(`pnpm-workspace.yaml`), so the mechanism was **re-confirmed against 0.5.5**:
`close()` is unchanged in the relevant ordering (`_checkReady` → `#closing` →
close listeners → `_pgl_setPGliteActive(0)` → `await execProtocol(end())` →
`await closeFs()`; 0.5.5's only delta is saving/restoring `exitCode` around
`_emscripten_force_exit(0)`, after deactivation and irrelevant here), and the
Mastra-free repro reproduces on the installed 0.5.5 — drain arm returns in 1ms,
race arm hung indefinitely with neither promise settled. Do not treat the 0.5.4
trace as the only evidence; the pinned engine is affected.

Because the wedge is inside synchronous WASM, the event loop is blocked: no
timer, no per-test timeout, and no unhandled rejection can fire. That is exactly
why the job runs to the CI cap instead of failing.

Statement trace, 1.26.2 (the DELETE and the `close()` that follows it 5ms later
both have a `START` and never an `END`):

```
[…368299] START #356 query: DELETE FROM mastra_workflow_snapshot WHERE …
[…368304] START #357 close
```

`@mastra/memory@1.26.2` does not introduce the hang — it **loses the race**. The
same two tests issue 705 statements on 1.26.2 versus 322 on 1.26.0 (the OM
observer/reflector does more cycles), which pushes the tail of that background
traffic past the teardown boundary. On 1.26.0 the same leaked statements land
*after* `close()` finished and reject cleanly with `Error: PGlite is closed`.

**So 1.26.0 is not safe by construction — it wins a race.** Holding the pin
restores green CI; it does not remove the hazard.

**App reachability — AUDITED by code reading (2026-08-16, BST-1329/BST-1330); not
instrumented.** The wedge needs DB work in flight at the moment a PGlite
`close()` runs. Verdicts, with the evidence in the BST-1329/BST-1330 tickets —
a stronger inference than the earlier "plausible, unverified", but still
inference: nobody has instrumented desktop shutdown or factory reset.

- **Desktop shutdown and factory reset: structurally safe, conditional on one
  invariant.** PGlite lives only in the DB-host utility process; every
  statement is a serially dispatched envelope (`db-host-entry.ts` runs exactly
  one request at a time) and `close()` executes only as the `'close'`
  envelope — a Mastra background statement and the in-host `close()` cannot
  overlap **as long as that dispatch stays strictly serial**; that seriality
  is the invariant this verdict rests on. Independently, `DbHostManager.close()`
  kills the host after a 2s ack race, so an in-host wedge is bounded — the
  main-process event loop is never blocked, which is the proven bound (the
  60-minute CI-shaped wedge would need that kill path to fail too). Note
  `close`/`reset` are *control* requests dispatched even while a transaction
  is open. The one in-host non-envelope statement issuer (the live
  extension's internal refreshes) is drained by BST-1330's awaited
  live-unsubscribe in the `'close'`/`'reset'` handlers, which warns on any
  handle that fails to unsubscribe.
- **The web direct path is where the class is reachable**: web factory reset
  closes with no scheduler join, no submission barrier, and live handles still
  subscribed (its own purge DELETEs trigger refreshes racing `close()`), plus
  the narrow DbProvider prod-unmount-mid-init case — tracked as **BST-1329**.

(Close paths are owned by `docs/agents/database.md`; factory reset is a
cross-cutting invariant in `AGENTS.md`.)

Mastra-free proof of the mechanism — awaiting the statement before `close()`
returns in 1ms; starting the same statement and calling `close()` without
awaiting it hangs both promises forever:

```js
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
await db.query('CREATE TABLE t (workflow_name TEXT, run_id TEXT)');
await db.query("INSERT INTO t VALUES ('agentic-loop', 'run-1')");

// The unawaited background statement, exactly as core leaves it after a run.
const background = db.query('DELETE FROM t WHERE workflow_name = $1 AND run_id = $2', [
  'agentic-loop',
  'run-1',
]);

// await background;   // <- with this line: close() returns in 1ms
await db.close(); //    <- without it: this promise never settles
```

Two things ruled OUT, with evidence:

- `patchThread` — core 1.59 implements it as a wrapper that delegates to
  `updateThread`, so this repo's `PgliteMemoryStore` override is still reached.
- `error: extension "vector" is not available` — the failing
  `CREATE EXTENSION IF NOT EXISTS vector` appears in the statement traces of
  **both** versions (1.26.0 statements #80/#152, 1.26.2 statements #110/#349),
  so it is not version-specific and not the hang. It is pre-existing test
  wiring: the spec's `beforeEach` builds a bare `new PGlite()` with no `vector`
  extension, and only the first test rebuilds the instance with it, so the
  VECTOR test's vector-store init always fails.

  **This is a false green, not a cosmetic wart — tracked as BST-1325.** The test
  is named for vector retrieval and sets `retrievalMode: 'vector'`, yet its
  vector store can never initialize, and the very assertion meant to catch that
  (`expect(failureParts).toEqual([])`, i.e. no `data-om-observation-failed`
  part) does not fire. Its `embeddingRequests` assertion is satisfied by the
  semantic-recall embedder, which needs no pgvector. The test would keep passing
  if the OM vector path broke entirely. It also sits in the blast radius of the
  "every PGlite construction site loads the full engine-extension set"
  invariant (`AGENTS.md`, `docs/agents/database.md`) — it escapes the letter of
  the rule because it runs no migrations, but it is the drift the rule exists to
  catch.

**No clean in-repo fix exists today.** Draining before close needs a join point
Mastra does not expose; a `SELECT 1` flush or a sleep only narrows the window
(silent degradation), and a `Promise.race` timeout cannot fire against a blocked
event loop. The real fixes are upstream, and both are filed:

- [electric-sql/pglite#1084](https://github.com/electric-sql/pglite/issues/1084)
  — `close()` must serialize against in-flight statements, or reject them with
  the existing `PGlite is closing` error, instead of wedging. **This is the one
  that unblocks the bump.**
- [mastra-ai/mastra#21617](https://github.com/mastra-ai/mastra/issues/21617) —
  post-run background DB work needs a join point (the `pendingVectorCleanup` /
  `trackVectorCleanup` handle 1.26.2 added for `deleteThread` is the right
  shape), plus the reflector retry ladder re-running four identical attempts.

Tracked in BST-1320. **Re-test the bump when pglite#1084 lands** — that is the
signal, not a new `@mastra/memory` release. The close-path hazard is mirrored in
`docs/agents/database.md` (PGLITE EXTENSION INVARIANT → "CLOSING a PGlite"), so
it is discoverable from the side that would trip it.
