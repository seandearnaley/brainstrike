# Explicit Electron utility transport — 2026-10-02

Boundary: independent M2 adapter atop indexer `30b82287a`, with native prerequisite
`aeec75d625589dd5dc46ed227ee7f873c81fbc96` retained as cherry-pick `8a7c17470`.
Hosted CI remained disabled; no push, remote review request or merge was performed.

## Implementation

`@brainstrike/indexer/transport` owns typed Promise RPC/lifecycle independent of
Electron. `/host` hosts the same compiled reader/writer-worker core. Node's
`openIndexer(options, deadlines)` explicitly uses Node advanced IPC with its own
runtime. Desktop `IndexerHostManager.create(options, deadlines)` dynamically
imports ESM transport from its CJS bundle, resolves the utility entry as a bundle
sibling and launches only after Electron app readiness. ParentPort uses vendor
structured clone; no cross-runtime V8 serialization or child-process fallback.

Startup/request/close/exit deadlines must be finite positive caller-provided
values. They are foundation resource bounds, not measured production policy.
The tests use startup/request/close 5000ms for ordinary work, 150ms for intentional
utility stalls, exit 1000ms; standalone failure fixtures use 100ms. A confirmed
kill is remembered, so cleanup joins rather than attempting a duplicate kill.
Refused/thrown kill or failed exit join retains the owner in a lifecycle error
with an explicit close handle. Process replacement is deliberate fresh ownership.

## Local evidence

- Real Mac arm64 Node26.8.2: 13 native integration cases plus3 actual
  process lifecycle controls pass. Controls stall startup, inject kill false and
  kill throw, observe the original process still live, then restore real kill and
  join explicit retry cleanup. No mock database or new quarantine.
- Real Mac arm64 Electron44.4.5:4 integration cases pass. Positive proves separate
  utility PID, writer thread, WAL, query-only reader, vec0.1.9, lexical/vector
  retrieval, root filtering, no-op preparation, incremental replacement, close,
  fresh-owner reopen and destroy removing database/WAL/shared-memory files. Three
  controls intentionally stall startup/search/close acknowledgement; enforced
  caller deadlines surface failure and join actual utility exit.
- Initial harness failures were jsdom/esbuild realm mismatch and absent dist
  parent directory; the native test uses the Node environment and a task-owned
  temporary output directory. These are harness REDs, not indexer defect proof.
- Initial actual positive assertion expected kill(pid,0) to throw immediately
  after graceful vendor exit. It failed. A diagnostic captured macOS ps state
  `?E (Electron Helper)` (exiting) after Electron's exit event. The canonical
  lifecycle join is the documented UtilityProcess exit event; PID existence is
  not an immediate OS-reap guarantee. Final tests assert that actual event was
  joined and prove subsequent reopen/reset, without a delay or weakened owner.
- A forced run exposed an aggregate5000ms test-clock failure in the old single
  profile-mismatch test (five refused profiles and fresh reopen, seven sequential
  process starts). The five cases are now parameterized independently, each
  retaining rejection plus actual reopen/data preservation. No timeout increased,
  suppression or quarantine was added.
- Deadline-disable mutation control was not executed and is unqualified. Root
  requested keeping all enforced safeguards; no such mutation was applied.

Durable logs: `/Users/seandearnaley/Documents/brainstrike-indexer-utility-2026-10-02/`.
Final check outcomes and exact commands are recorded in that directory's README.

## Pending product gates

No main bootstrap, IPC/preload, factory-reset orchestrator, querySelf or producer
cutover is included. Canonical AST/text chunks and same-parser syntax metadata
must be forwarded by a later validated provided-chunks preparation API; no second
parser/walker and no fallback to foundation line segmentation. Desktop profile
path/reset registration, measured host policy, packaged transport and remaining
platform qualification remain required. This proof is not full-app throughput,
retrieval quality or five-platform acceptance.
