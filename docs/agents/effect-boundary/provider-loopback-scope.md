# Provider OAuth loopback listener and wait ownership

Supports `docs/agents/effect-boundary.md` § "Shared helpers" and
`docs/agents/assistant-providers.md` § "Provider OAuth engine".

## Rule

The provider callback listener has an actual Effect Scope finalizer. One
Deferred carries the terminal callback result; its sole wait owns the timeout
through acquireRelease. Repeated waits fail visibly. Every close caller joins
the same server shutdown and the wait's timer release. Server shutdown attempts
both close and closeAllConnections, joins both, and preserves their failures.

## Evidence (2026-09-27, BST-1846)

The original implementation assigned one mutable pending waiter and timer on
every wait call. A second wait orphaned the first. Its closed flag also became
true before server.close completed, allowing a concurrent close to resolve
before listener teardown. Two real-socket regression tests failed against that
implementation while all 13 existing security/socket tests passed. RED log:
`/tmp/bst-1846-red.log`.

The implementation retains native Node HTTP operations and the existing
Promise handle. Effect owns resources and the callback cell rather than
introducing an HTTP framework. All runners cross through effect-kit's
runAtPromiseBoundary; preload and IPC contracts remain dependency-free.

The OAuth flow starts the wait before openExternal. Early callbacks remain
terminal and later waits retain the existing already-settled error; this
change deliberately adds no replay or buffered-success behavior.

Scope.close marks its scope closed before asynchronous finalizers complete.
The handle therefore memoizes a close Promise, and joins the separate wait
scope's completion as part of the same barrier. Effect.callback registration
cleanup runs on interruption, not success; binding removes its temporary error
listener explicitly on success, emitted failure and synchronous listen throw.

The socket lane delays the actual close callback to prove a second close stays
pending. Fault injection proves closeAllConnections failure cannot bypass that
callback barrier, both failures are retained, and acquisition rollback retains
both bind and cleanup errors. Real addLogListener records prove automatic
cleanup logging has a fixed token-free message; close callers still receive
the actual cleanup failure.

Existing fixed port, loopback-only binding, Host validation, nonterminal bad
state, absence of an HTTP cancel endpoint, typed errors and HTML/security
headers remain covered by the existing real-socket suite. Successful HTML
response flushing remains before automatic teardown.

## Validation

- RED: two intended failures, 13 existing tests passed.
- GREEN: `pnpm exec vitest run src/__tests__/provider-auth/loopback-server.integration.test.ts`
  from apps/desktop; 26 tests passed (`/tmp/bst-1846-green.log`).
- Additional whole-provider, strict typing, contract/preload guards and bundle
  measurements are recorded by delivery after independent review.
- Whole-provider unit plus preload boundary: 14 files, 171 tests passed.
- Provider integration lane: 2 files, 27 tests passed (26 loopback plus the
  real fake-provider flow).
- Desktop main/test/E2E type checks passed; strict Effect diagnostics checked
  581 files with zero errors, warnings or messages.
- Both contract guards passed (26 tests). The new source guard also failed
  when its actual source read replaced Deferred.await(callback) with
  Effect.never, while the unmodified control passed.

## Bundle measurement

Compared the same checkout at base `5fd53f7a2` with this change using the normal
production builds. Gzip is level 9 per JavaScript file; renderer totals include
workers, not just startup-loaded modules.

| Output | Before bytes / gzip bytes | After bytes / gzip bytes | Delta bytes / gzip bytes |
| --- | ---: | ---: | ---: |
| Desktop main.js | 2,734,636 / 583,155 | 2,737,808 / 583,976 | +3,172 / +821 |
| Desktop renderer, 402 JS files | 22,656,198 / 5,241,440 | 22,656,198 / 5,241,440 | 0 / 0 |
| Web, 415 JS files | 17,848,773 / 4,963,376 | 17,848,773 / 4,963,376 | 0 / 0 |

Both renderer builds passed the cross-chunk cycle guard. No new dependency or
Effect version change; no renderer-reachable import was introduced. This is a
resource-ownership correction, not a measured throughput optimization.
