# Query listener readiness

Supports `../local-inference.md` § "Foreground query coordination".

The mounted host owns one query listener. A temporarily unavailable database must produce an explicit error even if main still caches a running status. Query model/service/activity belong to a database generation; old asynchronous completions cannot publish current activity or populate the replacement cache.

## 2026-09-30 — BST-1907

Ticket: BST-1907 (`cdbac340-d5a1-40f6-bb2e-2a5d384eac51`), parent BST-1899.

A normal native retrieval query exhausted its 60-second host-response budget with one pending manager request. The retained pack does not locate the renderer stage that failed. A fresh normal native query completed in about three seconds; a subsequent query after real Vite HMR completed in 949ms. HMR alone is therefore not a reproduced cause of that incident.

The separate deterministic readiness defect uses the existing public manager and renderer preload fixture: after a running host loses its DB readiness, defer renderer status delivery to main, then dispatch a query against main's cached running status. The original DB-owned listener is absent and the manager retains one pending request. Reestablishing DB readiness cannot replay a lost event. With a component-owned listener, the same race returns an explicit unavailable error and clears the request without inference, retry, fallback, or a second listener.

`apps/desktop/src/__tests__/renderer/components/embedding-host-reinitialization-readiness.test.tsx` pairs that RED/GREEN control with honest starting status, immediate component replacement, held model read and preference hydration, held model initialization, held old inference versus current activity, selected Stop during inference, and old stop/service disposal before replacement start. Existing manager cancellation and renderer control suites retain selected Stop and stale-runtime coverage.

The experiment is a DB reinitialization correctness fix, not proof of the original visible freeze or native timeout cause. The five-second background drain and concurrent foreground inference ownership remain separate investigation questions.

The current `SimpleEmbeddingService.initializeWithModel` backend initialization obtains the shared browser queue; it does not construct a per-service streaming client, worker, or pipeline on its failure path. The ownership change therefore does not add unrelated initialization-failure cleanup. A service whose initialization finishes after DB replacement is explicitly disposed before it can be cached.
