## 2024-05-22 - [Loop Unrolling in V8]
**Learning:** Manual loop unrolling (stride 4) provides significant speedup (~20%) for embedding math operations on vectors of size 384-768. However, combining multiple validation checks into a single boolean expression (e.g., `if (v1==u || v2==u ...)` was SLOWER than keeping them separate (`if (v1==u) throw; if (v2==u) throw;`).
**Action:** When unrolling loops in TypeScript/V8, prefer keeping simple, separate validation checks inside the unrolled block rather than creating complex boolean expressions, as the engine likely optimizes separate branches better or handles the short-circuiting more efficiently in the hot path.

## 2024-05-23 - [Single-Array Loop Unrolling Validation]
**Learning:** Contrary to dual-array operations, for single-array reductions (like `magnitude`), combining validation checks (`if (v1==u || v2==u ...)`) was FASTER than separate checks, yielding a ~24% speedup for 384-dim vectors. Unrolling the reduction step in `normalize` (which also involves division) degraded performance, confirming that unrolling benefits are limited to simple arithmetic.
**Action:** For simple reductions on single arrays, use combined validation checks in unrolled loops. Avoid unrolling loops with complex per-element operations like division.
