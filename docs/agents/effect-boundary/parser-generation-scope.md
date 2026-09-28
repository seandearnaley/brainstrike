# Parser utility-process generation Scope

Supports `docs/agents/effect-boundary.md` § "Shared helpers" and
`docs/agents/platform-contracts.md` § "Graceful shutdown ownership (hidden hosts and background indexing)".

## Rule

Own each parser process generation independently. Attach exit observation
immediately after fork, keep synchronous lazy startup/send, and register separate
Scope finalizers for the exit join and each listener. Stop snapshots every owned
generation, including older detached generations still closing. Successful kill
detaches the current generation so a replacement can start; public Stop joins
actual exit and resource finalizers. Concurrent calls join per-generation close.

A false or throwing kill fails visibly and retains the live owner, refusing
further parse sends until explicit Stop retry succeeds or natural exit is
observed. PID absence proves neither spawn nor exit. Message and exit callbacks
from retired generations cannot settle or reject replacement requests, even
when request IDs are reused. No request-channel, preload or parser protocol
change is involved; parse retains its always-answer response/error contract.

## Evidence (2026-09-28, BST-1853)

Three new tests failed against base 19cd6eb75 with all 17 prior tests passing:
Stop resolved before held exit, an old exit rejected a replacement with reused
request ID, and an old response supplied that replacement's AST. The tests
release held exits in cleanup rather than leaving test-owned processes pending.

The implementation owns listener removers and the actual exit barrier through
Scope. Its registration Promise is retained, observed and joined, while fork,
exit-listener attachment and postMessage stay synchronous. Partial message
listener attachment failure preserves the original send failure and invokes
owned cleanup. A failed cleanup remains logged through the real logging path
and its process remains owned for Stop retry.

Lifecycle tests cover false/throwing kill, blocked parse, explicit retry,
natural exit after failed Stop, concurrent Stops, later Stop including both
old and replacement generations, PID absence, synchronous exit during kill,
and partial message attachment that first registers the listener then throws.
The logger proof observes the existing addLogListener interface.

The held-exit integration test uses the existing runShutdownSequence with a
short test deadline: the parser step remains named, the following database step
does not run, and the timeout returns while the underlying process owner remains
alive for later exit cleanup. Production keeps the existing five-second overall
forced-exit budget. Parser remains omitted from the factory-reset runtime list;
this stateless process change adds no persisted state or reset policy.

The Effect and platform contract line budgets stay unchanged by joining existing
reference/reflow lines; no settled policy is removed. Initial publication waited for the
separate rc118 qualification PR and refresh of the branch base.

## Verification

- Desktop dependencies: `pnpm exec turbo run build --filter='@brainstrike/desktop^...'`.
- Baseline main: `pnpm --filter @brainstrike/desktop build:main`.
- Unit: `pnpm exec vitest run src/__tests__/main/parser-host-manager.test.ts` from apps/desktop.
- Integration: `pnpm exec vitest run --config vitest.integration.config.mts src/__tests__/main/parser-host-shutdown.integration.test.ts`.
- Types: desktop `type-check:main`, `type-check:test`, and strict Effect diagnostics against tsconfig.test.json.

Initial qualification uses the exact rc117 pin at the measured branch point;
final delivery qualifies the refreshed rc118 base. pnpm runs configured Node
26.8.2, with host PATH pinned to Node 26.10.0.

Initial focused results: 27 unit tests and one deadline integration test pass.
Desktop main type-check passes; the test program selects/type-checks 579 test
files; strict Effect diagnostics cover 584/584 files with zero errors, warnings
or messages. All 29 Effect/budget guards pass. Removing the owned exit await
makes the new structural guard fail, then restoration returns it to green.

## Initial bundle measurement

On the rc117 branch point and the parser candidate, `build:main` passes.
Main moves from 2,742,205 raw / 584,738 gzip bytes to 2,747,159 / 585,692
(+4,954 raw, +954 gzip). The other seven main/preload outputs are byte-size
unchanged, including parser-host-entry.js at 21,057 raw / 6,519 gzip.
These main-only imports do not add a renderer entry; Effect remains external
in main. Final rc118 qualification is recorded after the base refresh.

The existing real Electron/OXC routing E2E passes on the initial candidate:
`playwright test e2e/chunking-host-renderer.test.ts --project=regression
--workers=1 --retries=0 --grep 'engages the native oxc parser'` reports one
pass (18.6s including setup, test 4.6s). Normal fixture shutdown records the
parser-host step successful in 13ms and exits with code 0. This exercises the
production preload, manager and utilityProcess rather than its unit fake.
An unchanged snapshot startup sweep logged a database-retired error during
shutdown; that separate owner is tracked in BST-1859 outside this parser change.

## Final rc.118 qualification

After the separate dependency qualification merged, this branch was rebased once
onto `99bc2258e5040d0e361c0393584b7cdc71e94223` (including the MCP SDK 2.1
qualification). Frozen installation verifies Effect 4.0.0-rc.118. No parser,
shutdown, reset or governing contract changes were introduced by the SDK merge.

The refreshed candidate passes 37 focused unit tests across parser manager,
Schema and IPC routing, plus the held-exit deadline integration test. Desktop
main TypeScript and the 579-file test program pass; strict Effect diagnostics
check 584/584 files with zero errors, warnings or messages. All 29 Effect/budget
guards pass. The fresh desktop dependency closure builds all 49 tasks, and both
main and renderer builds pass, including the renderer's cross-chunk cycle check.

The matching rc.118 baseline and candidate use configured pnpm Node 26.8.2 and
gzip level 9 for each of the eight root JavaScript outputs. Main remains
2,742,205 raw / 584,738 gzip bytes before this change and 2,747,159 / 585,692
after (+4,954 raw / +954 gzip). All seven other main/preload outputs remain
unchanged; parser-host-entry.js stays 21,057 raw / 6,519 gzip. These are bundle
size measurements, not latency claims.

The real Electron/OXC routing E2E passes again on the refreshed candidate:
one test, 19.0 seconds including setup (3.5-second test). Graceful shutdown
records parser-host successful in 12ms and Electron exits with code 0. The
unchanged startup thread/snapshot sweeps again report retired-database errors
while shutdown runs; BST-1859 tracks that separate owner. No errors were
suppressed or reset policy changed to obtain this proof.

## Review batch: bounded caller wait

The completed whole-PR review identified that a held parser exit could consume
the full five-second application deadline and prevent later database/error-log
shutdown. Stop now bounds the caller's snapshot join at 500ms, matching the
existing chunking and LLM stop/destroy allowances and leaving room for later
owners. Observed real parser shutdown remains 12–13ms. The global deadline and
step order remain authoritative; this local allowance does not guarantee time
for every later owner when earlier steps are slow.

The timer bounds only the all-settled caller wait, never Scope.close. Timeout
rejects explicitly, with no successful cleanup or cancellation claim. Each
close Promise and generation remain owned until actual exit and listener
cleanup; repeated Stop waits reuse them without re-killing. Empty Stop starts
no deadline. Optional positive-finite stopTimeoutMs provides deterministic test
allowances. A 20ms local bound versus 200ms global bound reproduces the original
failure (global timeout and skipped later steps), then proves parser failure
is recorded while database and error-log steps succeed; retained listeners
clean only after the test supplies actual exit. The original outer-deadline
proof remains, since an earlier application deadline still takes precedence.

The setup rejection handler changes state only while live, preventing a
backward transition after closing. The test mock no longer changes real global
logger configuration; listener-based cleanup logging remains exercised.

Review-batch verification passes 41 focused unit tests, both shutdown integration
tests, desktop main TypeScript, the 579-file test program and strict Effect
diagnostics on 584/584 files with zero diagnostics. All 29 contract/budget
guards pass. Temporarily changing the default 500ms allowance to 501ms makes
the paired guard fail, then restoration returns it to green. Full-tree
Ultracite reports no fixes, with only the existing 15 warnings.

The reviewed candidate main build is 2,747,860 raw / 585,827 gzip bytes versus
the same rc.118 baseline 2,742,205 / 584,738: +5,655 raw / +1,089 gzip.
The seven other outputs remain unchanged. The native routing E2E passes again
in 17.9 seconds including setup (3.8-second test), parser stop succeeds in
13ms, and Electron exits with code 0. Known BST-1859 logging remains visible.
