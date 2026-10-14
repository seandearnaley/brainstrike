# The @mastra/memory 1.26.0 hold — evidence

Supports `docs/agents/mastra-boundary.md` § "`@mastra/memory` hold at 1.26.0
(BST-1320) — SUPERSEDED BY BST-1667". Historical: `@mastra/memory` is pinned at
1.28.2 on `@mastra/core` ^1.64.0 today. Read this for the A/B that diagnosed the
observational-memory stall; the mechanism itself is in `pglite-close-race.md`.



**Superseded by BST-1667 (2026-09-06):** `@mastra/memory` is now pinned at
1.28.2 alongside `@mastra/core` ^1.64.0. The record below is the 1.26.0/1.26.2
A/B as measured on core 1.59.0 and is kept as the diagnosis of the
observational-memory stall; it no longer describes the installed pin.

**Measured on core 1.64.0 + memory 1.28.2 (2026-09-06, BST-1667):** (1) the
race's SOURCE identified below — core's unawaited post-run `DELETE FROM
mastra_workflow_snapshot` — is gone in core 1.64: `deleteRunSnapshots()` is
awaited before `safeClose(controller)` on every terminal path of the agentic
loop (timeout, failed, non-suspended, success), so that statement can no longer
be in flight when a caller closes after consuming the stream **to its end**. A
caller that abandons the stream early (watchdog abort, Stop) still races it —
traced 2026-09-12 under BST-1221 — so every Brainstrike attempt joins
`consumeStream()` at its cleanup boundary (`settleNativeStream`, contract in
`docs/agents/assistant-persistence.md`). (2) Mastra >= 1.62
adds `Memory.settled()` ("Resolve once all background work this memory started
has finished… Callers that own the storage connection should await this before
closing it"); in `@mastra/memory` it joins the observational-memory engine's
background observer/reflector work, and
`mastra-memory-persistence.integration.spec.ts` now awaits it in `afterEach`
before `database.close()` — a run without it logged
`[OM] Async buffered reflection failed: Error: PGlite is closed`, the
clean-rejection arm of the same race. (3) The full `packages/agent` unit and
integration lanes ran to completion on this pin with no wedge (integration
245s, 37 files). (4) The hazard is NOT gone in general: forcing the abort seam
in `packages/agent/src/mastra/aborted-turn-persistence.ts` off (`shouldPersist`
false) still wedged the worker, so the seam's awaited `saveMessages` remains a
required join on abort paths, and `MessageHistory`'s abort-time write is not
covered by `settled()`. pglite#1084 and mastra#21617 below remain open upstream.

`@mastra/core` moved to ^1.59.0 here; `@mastra/memory` deliberately did NOT move
with it. **1.26.2 hangs the observational-memory suite forever.** Measured A/B,
both arms on core 1.59.0, only the memory pin changed:

| `@mastra/memory` | `packages/agent` `mastra-memory-persistence.integration.spec.ts` |
| --- | --- |
| **1.26.0** | 19/19 passed, 17.6s, exit 0 |
| 1.26.2 | 16 passed, then stalls forever (killed at 300s) |

Two-test repro (`-t "DIRECT-provider observer|VECTOR retrieval"`): on 1.26.0 both
pass (1155ms + 768ms); on 1.26.2 the first passes and
`completes an observation cycle with VECTOR retrieval + the real OpenAI embedder
wiring` never returns. Neither test hangs when run alone on either version —
consistent with the race described below, since an isolated test issues far less
background traffic, and therefore a cheap falsification test for the whole
mechanism. The test's own `30_000` timeout never fires — the block is not
interruptible by vitest's per-test timer. In CI this burns the whole
`Unit (rest)` job to its 60-minute cancellation.



**Security framing, stated precisely — do not overstate this cost.** 1.26.2 is
the only thing that drops `image-size@1.2.1` (`@mastra/memory` is its sole
dependent), which would clear two HIGH advisories (GHSA-w3rx-r6r6-pgpr,
GHSA-5p2g-fcmc-qvqq) and take `pnpm audit --prod` from 31 → 29 findings and
12 → 10 high. Holding at 1.26.0 **defers that improvement; it does not introduce
exposure.** `main` is on 1.26.0 and carries `image-size@1.2.1` today, and this
branch measures the same 31 findings / 12 high as `main`. The advisory fix
arrives when BST-1320 unblocks the bump — it is not something this PR gives up.

Peer compatibility is not a concern: 1.26.0 declares
`"@mastra/core": ">=1.4.1-0 <2.0.0-0"`, which 1.59.0 satisfies, and
`pnpm peers check` reports no `@mastra/*` issues.
