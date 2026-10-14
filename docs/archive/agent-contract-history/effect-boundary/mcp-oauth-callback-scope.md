# MCP OAuth callback lifetime evidence

Supports [Effect boundary contract](../../../agents/effect-boundary.md) § "Shared helpers".

BST-1832 replaces the callback listener's manual teardown paths with one held
Effect Scope. The server is acquired and its release finalizer registered before
binding starts. Startup failure, authorization timeout, and explicit close all
close that same Scope. The finalizer joins the Node close callback and connection
cleanup, keeps the bound error reporter until the close callback, and reports
cleanup failures. A failed preferred-port bind still reports and retries a fresh
port; the temporary bind error listener is removed on every outcome.

Each claimed authorization wait runs through `Effect.callback` with one
`Effect.ensuring` finalizer that clears its timer and resolver. The attempt is
captured by that finalizer, so an immediate cancel and re-arm cannot clear the
replacement attempt. Explicit close fences new callbacks synchronously and joins
the Scope close and all outstanding wait Promises. Timeout closes only the Scope
before rejecting its waiter, avoiding a self-join. The public API remains Promise
based, and `runAtPromiseBoundary` is its only Effect runner.

This adds state and lines to the module: the baseline was 178 lines and this
implementation is about 300. The added state owns duplicate waits, terminal
close admission, and concurrent close/timeout joins that the old implementation
did not safely cover. The gain is release registration before binding, one
server finalizer across startup failure/timeout/close, one waiter finalizer on
every completion path, and a public close that joins both. This is not a
line-count reduction. A hardened Promise-only version could be shorter but
would have to preserve the same attempt and join state.

RED on the old code: duplicate wait, close with a pending timer, and timeout
followed by re-arm failed. GREEN: focused real-loopback callback tests, provider
OAuth integration, the paired boundary guard with a deliberate falsification,
desktop type check with strict Effect diagnostics, and the desktop main build.
The callback tests also pin wait-before-arm, callback-before-wait, invalid-state
response after terminal close, persisted-port fallback, bind and close failures,
and late bound-listener errors. Local warm 200-cycle start/close timings were
about 3.6 ms at baseline and 5.6–7.9 ms with the Scope, so this boundary is
slower by a few milliseconds per 200 cycles. It runs once per authorization
listener lifetime; the cost is small beside a human OAuth flow. The desktop
main bundle moved from 2,705,065 to 2,709,557 raw bytes (+4,492), and from
579,908 to 580,890 bytes with the same Node 26 default gzip (+982). Focused
callback/provider/host units passed 44/44, real provider integration 33/33,
contract and line-budget guards 23/23. The new guard failed as expected when
`Effect.acquireRelease` was deliberately removed. Desktop type check,
including strict Effect diagnostics, passed.
