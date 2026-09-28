# File-tree operation scopes

Supports `effect-boundary.md` § "Shared helpers".

BST-1854 hardens the existing file-tree worker port's three bulk operations. Each uses a Scope-owned pending entry acquired before posting. Success, worker errors, cancellation, supersession, termination and posting failures detach the exact owner before settlement. Scope release also fences cleanup by owner identity. This owns local correlation state; it does not imply interruption or cancellation of remote worker execution. The worker-runtime root and worker listener lifetime remain unchanged.

The original implementation rejected a command-send exception through the Promise executor but retained its pending owner. Supersession rejected the old Promise then posted abort before publishing the replacement; a throwing abort retained the stale old owner. Four regressions reproduced these failures: 4 failed and 141 existing tests passed. Recovery tests verify the next request posts without an unnecessary stale abort, not just that the first Promise rejects.

Synchronous completion followed by a posting exception keeps the first completion, including the original expanded-paths reference. A completed owner's later Scope cleanup cannot erase a synchronously started replacement. Operation IDs and command ordering stay unchanged; patches, progress, request-load aborts and existing error sentences retain their previous tests. Arbitrary thrown values cross the Promise boundary by identity through a private typed failure wrapper.

Verification commands:

- `pnpm --filter @brainstrike/file-tree-worker test`
- `pnpm --filter @brainstrike/file-tree-worker type-check`
- `node --test scripts/__tests__/effect-boundary-contract.test.mjs scripts/__tests__/agent-contract-budget-contract.test.mjs`

Initial bundle qualification below uses the existing rc.117 pin. Delivery requalifies against the separately approved Effect release after the predecessor merges.

All 151 tests in nine files pass. Production TypeScript passes, and strict Effect diagnostics check all 18 source/test files with zero errors, warnings or messages. The package follows the existing chunking-worker gate: production `tsc` plus Effect diagnostics on the widest test configuration. A separate TypeScript check of the changed `port.test.ts` passes using a temporary package-local config extending `tsconfig.test.json` with `include: ["src/port.test.ts"]`, run with `pnpm --filter @brainstrike/file-tree-worker exec tsc --noEmit --project tsconfig.port-check.json`; the temporary config is removed afterward. Full test-program TypeScript was explored but exposes existing BFS fixture errors (legacy Vitest mock generic signatures, omitted operation IDs and optional-property fixtures) and an existing worker-message cast. This change does not claim full test-program TypeScript coverage or weaken the production gate.

The paired ownership guard was falsified by temporarily replacing the sole `Effect.acquireRelease` with `Effect.acquireUseRelease`: its focused invocation failed, then the original source was restored. The final contract/guard suite passes 29 tests. The contract retains its 105-line budget. Dependency installation uses the existing exact rc.117 catalog pin on this branch; only the file-tree importer changes in the lockfile, with no unrelated resolution changes.

Independent review additionally exposed synchronous native-abort reentrancy: an old request-load signal listener can start a replacement while a superseding operation is still posting. The regression failed before ownership checks were added after native abort and transport abort; the corrected operation stops posting once superseded. Request-load cancellation snapshots and clears old ownership before invoking abort callbacks, preserving newly admitted controllers and their results while dropping old results. A second test starts the replacement from the transport abort itself.

Public abort snapshots the operation epoch so an abort callback that admits a replacement cannot be followed by a stale remote abort. Termination closes bulk admission before invoking callbacks, returning the existing termination rejection sentence for reentrant or later bulk operations. Two focused regressions fail before these fences and pass afterward; no new synchronous exception is introduced for the Promise operation methods. Runtime failure keeps its existing synchronous latch behavior. The final suite includes ten new cases and passes 151 tests in nine files.

## Initial rc.117 bundle qualification

Measured from branch point `19cd6eb75` with pnpm's configured Node 26.8.2, fresh dependency closure (49 successful tasks), and successful desktop renderer and web builds including cross-chunk cycle checks. Baseline app output comes from the independent parser checkout at the same branch point and renderer/web source. Totals sum every emitted JavaScript file and its gzip level-9 size; startup totals follow static imports from HTML module/modulepreload entries. Both startup closures contain no external bare imports.

| Output | Baseline JS files | Candidate JS files | Baseline raw / gzip bytes | Candidate raw / gzip bytes | Raw / gzip delta |
| --- | ---: | ---: | ---: | ---: | ---: |
| File-tree package | 2 | 2 | 102613 / 23926 | 104400 / 24407 | +1787 / +481 |
| Desktop renderer | 399 | 400 | 22712903 / 5252265 | 22716446 / 5253446 | +3543 / +1181 |
| Web | 415 | 415 | 17874681 / 4972161 | 17877851 / 4973365 | +3170 / +1204 |
| Desktop startup closure | 80 | 81 | 10321199 / 2226258 | 10324718 / 2227400 | +3519 / +1142 |
| Web startup closure | 3 | 3 | 16268 / 6469 | 16268 / 6464 | 0 / -5 |

The actual `file-tree.worker.js` stays 85444 raw / 20185 gzip bytes; only the package port entry grows. Web's startup gzip difference reflects changed emitted filenames at unchanged raw size. These are bundle-size measurements; no latency claim is made.

## Final rc.118 qualification

Rebased onto `99bc2258e` (the SDK 2.1 baseline) and requalified with the exact `4.0.0-rc.118` catalog pin and configured Node 26.8.2. The rc.117 statements above describe the initial qualification only. The lockfile adds only the file-tree importer's nine dependency lines; catalog conformance checks 606 family importer entries, and frozen installation succeeds.

All 151 tests in nine files, production TypeScript, strict Effect diagnostics across 18 source/test files, the isolated changed-port-test TypeScript check, and all 29 contract guards pass. The contract's 105-line budget and rc.118 import restrictions remain intact. Fresh dependency builds pass all 49 tasks. Desktop and web builds pass, including cross-chunk cycle checks (401 chunks / 1288 static edges and 416 chunks / 1196 static edges respectively).

The same measurement helpers and gzip level-9 method compare fresh candidate output with the saved rc.118 baseline. Startup totals follow static imports from HTML module/modulepreload entries; these measurements make no latency claim.

| Output | Baseline JS files | Candidate JS files | Baseline raw / gzip bytes | Candidate raw / gzip bytes | Raw / gzip delta |
| --- | ---: | ---: | ---: | ---: | ---: |
| File-tree package | 2 | 2 | 102613 / 23926 | 104400 / 24407 | +1787 / +481 |
| Desktop renderer | 399 | 400 | 22731833 / 5258351 | 22735563 / 5259551 | +3730 / +1200 |
| Web | 415 | 415 | 17877480 / 4973838 | 17880801 / 4975137 | +3321 / +1299 |
| Desktop startup closure | 80 | 81 | 10339343 / 2232278 | 10343049 / 2233494 | +3706 / +1216 |
| Web startup closure | 3 | 3 | 16792 / 6817 | 16792 / 6817 | 0 / 0 |

The actual `file-tree.worker.js` remains 85444 raw / 20185 gzip bytes. The package port entry grows from 17169 / 3741 to 18956 / 4222 raw / gzip bytes. The SDK baseline change is included on both sides of this comparison.

## Real worker E2E qualification

On the rc.118 candidate, two existing Electron regression tests pass with one
worker and zero retries (24.7s including setup): progressive Expand All cancellation
(3.6s) and expanded-path restoration after app restart (7.2s). The first drives
`expandAll` through the actual module Worker and port with deterministic filesystem
fixtures; the second exercises multi-path `loadPaths` restoration. This does not
claim UI coverage of `loadSubtree`, which has no production port caller and retains
its package-level tests. The known snapshot-startup retired-database log remained
visible during fixture shutdown and is tracked separately in BST-1859.

Command from the repository root:

```sh
pnpm --filter @brainstrike/desktop test:e2e e2e/file-explorer-selection.desktop.test.ts e2e/file-explorer-selection-restore.desktop.test.ts --project=regression --grep 'expand all progressively reveals directories|restored explicit folders can be deselected'
```

## Final publication base

Folded once onto parser merge `ee73b9bba4fb3d8d73342700564b581d88a40233`, preserving both parser and file-tree contracts and guards at the 105-line contract budget. The fold changes no file-tree source or tests. Frozen installation, all 151 package tests, production TypeScript, strict Effect diagnostics across 18 files, the isolated changed-port-test TypeScript check, and the combined 30-test guard suite pass. The additional guard is the merged parser ownership guard. A fresh desktop build validates the parser base and passes its renderer cycle check; renderer measurements remain identical to the final rc.118 candidate above. Web and worker source/dependencies are unchanged, so their recorded build, size and real-worker E2E proofs remain applicable. The lockfile delta against the merged base is still only nine file-tree importer lines.

## Public-abort review correction

The completed initial review found that skipping the remote abort after a
signal callback admits a replacement leaves the old worker operation running.
A new ordering regression fails on the reviewed head (one failure, 151 passes).
Public abort now snapshots and detaches old request-load controllers before
posting or calling user callbacks, rejects the pending owner, and posts remote
abort before invoking the captured controllers' abort callbacks. Controller
cleanup runs in finally even if runtime failure or posting throws; arbitrary
posting failures keep their synchronous thrown identity.

Signal-callback and transport-post reentry both prove the worker receives
loadPaths, abort, loadPaths in that order. The replacement's request-load signal
stays live and its result completes, while old results remain detached. A
posting-failure test proves captured native work is aborted even when posting
throws. This replaces the earlier epoch-skip public-abort policy; supersession,
termination admission and scoped first-outcome ownership remain unchanged.

The correction passes 153 package tests in nine files, production TypeScript,
strict diagnostics on 18/18 files with zero diagnostics, the isolated port-test
TypeScript check, and all 30 contract guards. Removing the public-abort map
clear makes the paired guard fail; restoration returns it to green. Fresh
49-task dependency, package, desktop renderer and web builds pass, including
cross-chunk cycle checks. The new final size totals, compared with the same
saved rc.118 SDK baseline, are:

| Output | Candidate JS files | Candidate raw / gzip bytes | Raw / gzip delta |
| --- | ---: | ---: | ---: |
| File-tree package | 2 | 104410 / 24394 | +1797 / +468 |
| Desktop renderer | 400 | 22735720 / 5259596 | +3887 / +1245 |
| Web | 415 | 17880824 / 4975149 | +3344 / +1311 |
| Desktop startup closure | 81 | 10343206 / 2233517 | +3863 / +1239 |
| Web startup closure | 3 | 16792 / 6818 | 0 / +1 |

The actual file-tree worker entry remains unchanged. Web startup retains its
three-file static graph and unchanged raw total; gzip varies with hashed import
filenames. No latency claim is made.

Both existing real module-Worker Electron regressions pass again on the correction
(25.7s including setup, one worker and zero retries). Full-tree Ultracite applies
no fixes and reports only the existing 15 warnings. Package ordering remains as
formatted. The broad port-level no-Promise structural assertion is retained as a
nonblocking review nit; ownership regressions and the scoped-owner guard provide
the decisive behavior proof, and no unrelated Promise path is added here.
