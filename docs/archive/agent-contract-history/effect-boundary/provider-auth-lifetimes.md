# Provider authorization lifetimes

Supports `docs/agents/effect-boundary.md` § "Shared helpers" and
`docs/agents/assistant-providers.md` § "Provider OAuth engine".

## Decision (2026-09-25, BST-1826)

Use Effect for the provider device-flow polling program and the common OAuth
request deadline. Keep the engine in Electron main, Promise APIs at callers,
provider adapters responsible for wire shapes, and the existing error classes.
This extends ADR-0004's runtime-boundary adoption; it introduces no runtime,
Layer graph, new provider, credential storage, or change to the legal gate.

One `guardedFetchText` operation owns both headers and response text. Previously
`guardedFetch` returned at headers, and each of its three callers read the body
outside that function. The native timeout signal remained live, but rejection
depended on the transport observing it. An Effect deadline now bounds the whole
operation and signals fetch to abort. Interruption ends the wait even for a
non-cooperative transport; it does not claim such a transport stopped executing.
Late Promise settlements stay observed and cannot publish a token grant.

Token exchange, refresh, and device authorization share this complete response
boundary. Refresh's single-flight, rotation, persistence and disconnect epochs
remain outside it. Device polling retains its immediate first request, bounded
waits, safety margin, adapter-specific slow-down decisions and terminal outcomes.
The default polling wait uses Effect sleep so cancellation releases its timer.
An injected non-cancellable Promise sleep can only have its wait interrupted.

## Qualification

`npm view effect dist-tags` still reports RC `4.0.0-rc.117` and stable `3.22.2`.
No dependency bump or unstable import is part of this change. The installed
RC's documentation and source are the API reference.

The shared-boundary contract guard failed before the adoption and passed after
all three callers moved their body read under `guardedFetchText`.

The clean base is `39fcd7038c651f6636e6d737ae0c06078588dc11`. A canonical
`pnpm build --filter @brainstrike/desktop` produced main.js at 2,698,158 raw
bytes and 574,862 bytes using `gzip -9 -c`. Effect remains external in the main
bundle; these numbers measure bundled application code, not installed package
size. This adoption is main-only, with no renderer-reachable Effect import.

The candidate build measured 2,699,875 raw / 575,246 gzip bytes: +1,717 raw
and +384 gzip. All 50 canonical build tasks passed (47 cached). The OAuth
suite passed 175 tests across 15 files, including fake-provider integration,
IPC authorization, refresh rotation and the new cancellation regressions.
All 18 Effect and contract-budget checks passed; the full desktop type-check
and Effect diagnostics passed. No preload import is added.

A read-only probe of the original guard left both an uncooperative fetch and
a stalled response body pending beyond 40 ms with a 10 ms deadline. The new
tests deterministically reject at the deadline and observe the aborted fetch
signal. Success clears timers/listeners, a late rejection stays observed, a
cancelled body cannot produce a late grant, and a timed-out refresh keeps
single-flight without persisting a late rotation. A zero deadline still lets
an immediately resolved response/body win, as the Node 26 native signal did.

An isolated in-memory Response benchmark ran 550 requests per implementation,
discarding 50 warmups. Median/p95 milliseconds: native baseline 0.006458 /
0.012542; Effect 0.013458 / 0.022250. This measures request-boundary overhead
with no network, not end-to-end provider latency. The roughly 0.007 ms median
increase buys the complete response deadline and deterministic cleanup.
