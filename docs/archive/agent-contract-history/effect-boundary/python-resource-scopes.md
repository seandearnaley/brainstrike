# Python cold-install resource scopes

Supports `docs/agents/effect-boundary.md` § "Shared helpers" and
`docs/agents/code-execution.md` § "The run_python tool".

## Rule

Actual hash streams and tar children close before cold-install promises settle
or staging cleanup begins. Register staging removal before mkdir can create
partial resources. Retain the primary failure; report secondary removal failure
through the scoped logger. A cleanup-only failure is PythonUnpackFailedError
with the cleanup error as its cause.

## Evidence (2026-09-27, BST-1847)

Two regression tests failed against the preceding runtime: aborting a held hash
stream did not destroy it, and an early tar abort callback began staging removal
while the child close event remained withheld. All 34 preceding unit tests
passed. The controlled fixtures release close in finally, so a failing assertion
does not strand a test-owned resource.

The Node 26.10 native probe independently observed abort ordering:
execFile callback (ABORT_ERR with controller.reason as cause), child error,
exit(SIGTERM), then close(SIGTERM). Node documents child close as the process
and stdio completion boundary, and stream close as resource/descriptor closure:
[child close](https://nodejs.org/api/child_process.html#event-close),
[stream close](https://nodejs.org/api/stream.html#event-close_1).

The implementation keeps native Node APIs. Narrow Effect acquireRelease scopes
own descriptor/child close joins and staging removal. Hash result/error/data/end/abort handlers are registered synchronously in
acquisition before any fiber yield. Its Exit-valued result Promise retains early
failures without a rejection handler that discards them. Work listeners are
removed by the resource finalizer after close on success and failure;
listener release is joined rather than launched in a detached Promise. The resolver's outer Promise orchestration,
manifest Schema and runtime platform/error precedence remain intact.

Cancellation stays native within these resource boundaries: no caller signal is
passed to runAtPromiseBoundary. Hash interruption now destroys the stream and
rejects with that signal's reason after close. Tar retains its native AbortError
and cause, waiting for child close before surfacing it. This is not a claim that
all filesystem calls can be interrupted.

Unabortable mkdir/write/rename operations settle before cleanup. Cancellation is
checked before extraction and before install publication. Once atomic rename
commits a valid installation, or a competing installation verifies, that valid
result wins over late abort; this does not suppress cleanup failures or roll
back a committed install. A delayed rename fixture proves this existing terminal behavior and
that cleanup/public settlement cannot overtake the underlying operation.

The exact same Promise still coalesces callers by install identity. The first
caller owns its signal; aborting a joined caller cannot cancel shared work, while
aborting the first caller during hashing rejects both waiters. The map clears
on either terminal outcome, and later callers revalidate disk after reset.

Dedicated lifetime tests share fixture generation with the original unit suite.
They exercise acquisition-time hash abort, delayed successful/error descriptor
close, delayed successful/aborted child close, partial mkdir failure, delayed
mkdir cancellation, successful commit after delayed rename, cleanup-only errors
and primary-plus-cleanup errors. Logging assertions observe the real
addLogListener from the same module generation after vi.resetModules.

This hardens the runtime path on current main; the unmerged release-packaging
proposal in PR #2958 is a separate decision and is not changed here.

## Validation

- RED: two intended ownership failures; 34 existing unit tests passed.
- Run `pnpm exec vitest run src/__tests__/main/resolve-python-binary.test.ts src/__tests__/main/resolve-python-binary-resources.test.ts src/__tests__/main/resolve-python-binary.integration.test.ts`
  from apps/desktop. The integration lane unpacks the real pinned CPython and
  executes print(1+1), rather than substituting a mocked archive.
- Final focused lane: three files, 52 tests passed (34 original unit tests,
  17 resource-lifetime tests, one real-archive integration test).
- Effect and agent-contract guards: 27 tests passed. The actual new guard passes
  the source control and rejects an in-memory replacement of the descriptor
  close join with an already-resolved Promise.
- Desktop main and test type checks passed with 578 test files; strict Effect
  diagnostics checked 583 files with zero errors, warnings or messages.
- Adjacent boundary lane: eight files, 55 tests passed, covering preload import
  safety, main build imports, skill/run_python wiring, reset and packaging paths.

## Bundle measurement

Measured the fixed branchpoint `499db18b2` and the scoped-resource change using
normal production builds. Gzip is level 9 per JavaScript file; renderer counts
include workers. This measures footprint, not extraction throughput.

| Output | Before bytes / gzip bytes | After bytes / gzip bytes | Delta bytes / gzip bytes |
| --- | ---: | ---: | ---: |
| Desktop main.js | 2,737,808 / 583,976 | 2,742,205 / 584,738 | +4,397 / +762 |
| Desktop renderer, 399 JS files | 22,682,078 / 5,244,435 | 22,682,078 / 5,244,435 | 0 / 0 |
| Web, 415 JS files | 17,854,151 / 4,965,888 | 17,854,151 / 4,965,888 | 0 / 0 |

Both renderer builds passed the cross-chunk cycle guard. The seven other desktop
main entry outputs, including both preloads, remain byte-identical. No new
package or Effect version change is introduced.

## Exact-head review follow-up

A controlled error during data-listener acquisition exposed a leftover handler
in the preceding implementation. Registering the result and failure handlers in
the synchronous acquisition step fixes that gap; the failing control retained
its original error while leaving a data listener, and the changed code releases
all listeners. A separate regression delegates to actual Node execFile with a
known nonexistent absolute binary, observes callback/error/close, then verifies
the resolver reports PythonUnpackFailedError and removes staging. Failed-spawn
close remains the native resource boundary; there is no error-as-close shortcut
or timeout.

A second controlled case reports an ordinary tar failure, then aborts its caller
while child close is withheld. Mapping native failure at its first observation
preserves the ordinary typed PythonUnpackFailedError instead of reclassifying it
as a raw abort-time failure after close. Native abort failures still retain their
original identity. Synchronous execFile acquisition failures use the same local
classification; every error still waits for actual child close where a child
was acquired.

## Superseded (BST-1627)

The runtime unpack this record describes was retired: the interpreter is now
unpacked at build time and ships as loose files. See
[python-build-time-unpack](../code-execution/python-build-time-unpack.md).
