# Why the persist storage adapter resolves lazily — evidence

Supports `docs/agents/platform-contracts.md` § "Browser preference hydration".
Read before changing how a Zustand store picks between the Electron storage bridge and browser JSON storage. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
Zustand stores that choose between the Electron storage bridge and
`createBrowserJsonStorage()` must not resolve that platform adapter while the
module graph is still evaluating. Optimized Web chunking can place preferences
and storage exports in mutually dependent chunks; `createJSONStorage` catches a
factory error at that point and constructs a store without the `persist` API.

The `createJSONStorage` callback must return a locally declared async proxy
without reading imported runtime bindings. Zustand can call `getItem` during
store construction, so the proxy crosses a microtask boundary before invoking
its local platform-adapter factory. Successful resolution is memoized so later
browser operations keep their synchronous behavior. A failed resolution clears
the pending promise and is retried by the next operation; factory and operation
errors propagate unchanged. Do not call an imported lazy-storage helper from
this path: Rolldown may fold that binding into the cyclic consumer chunk and
leave it unavailable even after initial chunk evaluation. This preserves the
Web persistence capability without hiding a genuinely broken adapter. The
production-build regression is covered by
`apps/web/e2e/web-db-worker-startup.test.ts`, which treats both console errors
and unhandled page errors during startup as failures in the PR smoke lane.
