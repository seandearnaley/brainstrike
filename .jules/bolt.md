## 2024-05-22 - [Loop Unrolling in V8]
**Learning:** Manual loop unrolling (stride 4) provides significant speedup (~20%) for embedding math operations on vectors of size 384-768. However, combining multiple validation checks into a single boolean expression (e.g., `if (v1==u || v2==u ...)` was SLOWER than keeping them separate (`if (v1==u) throw; if (v2==u) throw;`).
**Action:** When unrolling loops in TypeScript/V8, prefer keeping simple, separate validation checks inside the unrolled block rather than creating complex boolean expressions, as the engine likely optimizes separate branches better or handles the short-circuiting more efficiently in the hot path.

## 2025-02-18 - [Minimatch RegExp Caching]
**Learning:** `Minimatch.match(str)` is significantly slower (~3.2x) than `Minimatch.makeRe().test(str)`. The `makeRe()` method returns a cached RegExp internally, but `match()` adds overhead (e.g. wrapper checks).
**Action:** For high-performance file filtering with simple wildcard patterns (e.g., in loops or recursion), cache the result of `Minimatch.makeRe()` and use `RegExp.test(str)` directly, falling back to `match()` only when `makeRe()` returns `false`.
