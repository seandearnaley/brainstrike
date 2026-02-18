## 2024-05-22 - [Loop Unrolling in V8]
**Learning:** Manual loop unrolling (stride 4) provides significant speedup (~20%) for embedding math operations on vectors of size 384-768. However, combining multiple validation checks into a single boolean expression (e.g., `if (v1==u || v2==u ...)` was SLOWER than keeping them separate (`if (v1==u) throw; if (v2==u) throw;`).
**Action:** When unrolling loops in TypeScript/V8, prefer keeping simple, separate validation checks inside the unrolled block rather than creating complex boolean expressions, as the engine likely optimizes separate branches better or handles the short-circuiting more efficiently in the hot path.

## 2024-05-22 - [String Processing Optimization]
**Learning:** Re-implementing `getFileExtension` with a single-pass loop (`charCodeAt`) instead of `lastIndexOf`, `Math.max`, and multiple `slice` calls yielded a ~4.3x speedup. Standard library methods can add significant overhead for simple string parsing tasks in hot paths.
**Action:** For high-frequency string parsing utilities (like file path processing), prefer manual character iteration over composing multiple string methods to minimize allocations and redundant scans.
