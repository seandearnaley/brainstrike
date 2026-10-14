# Full thread debug pack: snapshot, sections, host evidence — evidence

Supports `docs/agents/platform-contracts.md` § "DIAGNOSTIC EVENTS (FLIGHT RECORDER P1)".
Read before changing `readThreadDebugSnapshot`, its `SECTIONS` inventory, or the pack manifest. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
**Full thread debug pack**: persisted root and child conversations expose
`Debug pack` → `Download debug pack` through the shared conversation renderer.
The expanded control names included content before download. This explicit local
export includes conversation/file content, tool arguments/results, captured
settings, approvals and live decisions, the prompts each leg and specialist
received, parent wakeups and diagnostics, and on desktop the main-process log
window and process counters; it never uploads. Review the JSON locally
before sharing. This is the feature-specific content opt-in under
`docs/diagnostics-privacy-contract.md`, not new background telemetry.

`readThreadDebugSnapshot` in `packages/db` resolves the native thread and
revalidates the canonical authorized delegated graph. Its `SECTIONS` inventory
is the source of truth for included tables and columns. A single SQL statement
captures every listed section from the selected subtree, including retained
messages/branch edges, runs, events, errors, usage, diagnostics, verdicts,
projection rewrites, delegation budgets, invocations, decisions, continuations,
prompt manifests, wakeups, live decisions and complete stored tool artifacts.
Child usage follows exact invocation/continuation attribution; artifacts follow
`execution_thread_id`. A child-first-step prompt manifest is named by its
dispatching thread and follows its invocation into the child's subtree; wakeups
and live decisions follow the root host run, so a child-only export omits them. No status filter, row window
or output elision applies. Missing/deleted threads, invalid selected ancestry
and read failures fail the download visibly. Unauthorized descendants are excluded.

`packages/app-shell/src/diagnostics/thread-debug-pack.ts` emits versioned JSON
with section counts, snapshot time, canonical active run IDs, unknown run
statuses, retained artifact bytes and accounting completeness, artifact failures,
structural-elision counts, correlation instructions
and explicit evidence limitations. Retention/deletion, already-shortened stored
projections and unsaved active transcripts cannot be reconstructed. Empty
sections never claim that nothing happened. Artifact bytes are decoded before
key-name and value-shape secret redaction. Value scanning precedes JSON
serialization so multiline secrets remain detectable and JSON remains valid.
Deep and repeated/cyclic values receive visible bounded markers and manifest
counts. One corrupt artifact retains its identity and a typed failure in the pack
while other evidence stays available; malformed byte lengths are excluded from
the total and make its accounting explicitly incomplete. Collection and save
errors produce no partial success. The UI uses the
existing `downloadBlobFile` route and regenerates on each click. Child panels
inject their own thread binding. No new persistence is introduced.

Derived sections and host evidence (2026-09-15): `legs` (one row per run with
provider/model, the child persona from its admitted configuration, OpenRouter
upstreams, the last terminal `finishReason`, `lastStepFinishReason`, and step and
length-cut counts) and
`childFirstSteps` (the earliest child-first-step manifest per dispatch address,
later re-entries listed) are computed by `thread-debug-legs.ts` from the
snapshot and sit inside `sections`, so both redaction passes cover them; a row
missing an identity column fails the download. Host evidence is fetched when the
user clicks Download and is never persisted: `hostLog` and `processCounters`
come from the desktop main process through the capability probe
`readThreadDebugHostProbe`, and `manifest.host` records each as `included` or
`unavailable: <reason>` (no bridge, a rejected read, a malformed result, or no
run start to bound the window). The log window runs from the earliest run start,
clamped to 24 hours before capture, to capture. `manifest.permissionGates` lists
the redacted `permission.gate.resolved` events. `formatThreadDebugPack(snapshot,
host)` and `buildThreadDebugPack(db, threadId, probe)` take those inputs
explicitly.

Paired proofs: `thread-debug-snapshot.integration.test.ts` (real migrated
PGlite, prior-cap overflow, ownership, child approvals/usage/root and child
artifacts, swarm diagnostics with the child and grandchild first-step joins),
`thread-debug-pack.test.ts` (full output, corruption isolation, redaction, host
evidence and each missing-evidence reason), `thread-debug-legs.test.ts`,
`thread-debug-host-probe.test.ts`, `use-debug-bundle.test.ts`,
`thread-debug-pack-button.test.tsx` and `thread-debug-pack.browser.test.tsx`
(successful conversation, download failure and shared renderer at two widths).
