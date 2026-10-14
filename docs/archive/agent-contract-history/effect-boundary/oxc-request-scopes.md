# OXC IPC request scopes

Supports `docs/agents/effect-boundary.md` § "Shared helpers".

## Rule

Each request Scope owns its pending correlation entry and timeout. Release both
before public settlement for success, host failure, timeout or synchronous send
failure. Retain the first terminal outcome, including a synchronous reply
followed by postMessage throwing. The shared worker message listener lives for
the worker lifetime. Releasing local state does not cancel remote parsing.

Validate cached Schema field predicates and equal outer/inner request IDs.
Ignore malformed replies, allowing a later valid reply or the ordinary timeout.
Preserve legacy array envelope/response/root acceptance and the original opaque
AST reference; decoding or deep AST validation would change this boundary.

## Evidence (2026-09-27, BST-1848)

The two regression tests failed against base 9959c9119: a synchronous send throw
left one live timer, and a mismatched inner ID delivered the wrong AST. All nine
preceding tests passed. The updated adapter tests cover first-outcome reentrancy,
array containers and identity, exact owned timer removal, normal timeout after
malformed replies, shared-listener reuse and out-of-order concurrent isolation.

Final focused verification: 17 adapter tests pass, package TypeScript check
passes with strict Effect diagnostics (26/70 files, zero errors, warnings or
messages), and all 28 Effect/budget contract guards pass.

Commands:

- `pnpm exec vitest run src/__tests__/oxc-ipc-adapter.test.ts` from packages/chunking-worker.
- `pnpm run type-check` from packages/chunking-worker.
- `node --test scripts/__tests__/effect-boundary-contract.test.mjs scripts/__tests__/agent-contract-budget-contract.test.mjs` from repository root.

The contract retains its 105-line budget by consolidating an existing two-line
guard reference; no prior rule is removed. The new structural guard fails when
outer/inner ID equality is removed, then passes after restoration.

The adapter is selected for desktop execution. The shared facade statically
imports it even in browser builds; bundle measurements therefore include both
renderer targets. Runtime correlation measurements use synthetic synchronous
replies, not actual Electron IPC throughput.

The private tagged failure channel retains each original Error and unwraps it
at the public Promise boundary. Send errors keep identity; timeout and host
failure remain plain Error with their existing message. Adding an optional
field to the success response type makes the two-way key/type guard fail with
TS1360; restoring it returns the package check to green. The guard covers each
union arm separately, so optional fields cannot disappear in common union keys.

## Measured costs

Compared with base `9959c9119`, Node 26.10.0, unchanged lockfile. Build the
chunking-worker package before both application builds. Sum emitted JavaScript
bytes and per-file gzip level 9 sizes; startup closure follows only static
imports and modulepreloads from each HTML entry (no dynamic imports).

| Surface | JS files | Base raw / gzip bytes | Candidate raw / gzip bytes | Raw / gzip delta |
| --- | ---: | ---: | ---: | ---: |
| Chunking worker | 11 | 2,047,889 / 694,944 | 2,050,190 / 695,555 | +2,301 / +611 |
| Desktop renderer | 399 | 22,685,425 / 5,245,035 | 22,692,923 / 5,246,743 | +7,498 / +1,708 |
| Web | 415 | 17,857,107 / 4,966,433 | 17,863,423 / 4,967,986 | +6,316 / +1,553 |
| Desktop startup closure | 80 | 10,303,759 / 2,221,752 | 10,303,759 / 2,221,751 | 0 / -1 |
| Web startup closure | 3 | 16,268 / 6,467 | 16,268 / 6,467 | 0 / 0 |

Both startup closures have no unresolved external imports. Desktop main stays
2,742,205 raw / 584,738 gzip bytes; all eight main/preload output sizes are
unchanged. The one-byte startup gzip change is not a startup performance gain.

The synchronous mocked round-trip probe warms up 10,000 calls, then measures
three samples of 50,000 sequential calls, verifying AST identity each time.
Base samples: 27.603250 / 25.487792 / 27.528458 ms. Candidate samples:
122.797875 / 112.708583 / 121.743500 ms. Median overhead is approximately
1.88 microseconds per call (4.42 times this intentionally minimal baseline).
This measures local request bookkeeping only, excluding module initialization,
real IPC and native parsing. It does not establish end-to-end throughput or
startup latency. This bounded overhead buys deterministic cleanup and rejects
mis-correlated replies; remote execution remains unchanged.

Final local validation: all 174 chunking-worker tests, 49 adjacent desktop tests
across six parser/bridge/preload files, strict Effect diagnostics (26 checked
files of 70, zero findings), 28 Effect/budget guards, worker build, desktop
main/renderer builds and web build passed. No package or pin changed.
