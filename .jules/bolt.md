## 2024-05-22 - [Loop Unrolling in V8]
**Learning:** Manual loop unrolling (stride 4) provides significant speedup (~20%) for embedding math operations on vectors of size 384-768. However, combining multiple validation checks into a single boolean expression (e.g., `if (v1==u || v2==u ...)` was SLOWER than keeping them separate (`if (v1==u) throw; if (v2==u) throw;`).
**Action:** When unrolling loops in TypeScript/V8, prefer keeping simple, separate validation checks inside the unrolled block rather than creating complex boolean expressions, as the engine likely optimizes separate branches better or handles the short-circuiting more efficiently in the hot path.

## 2026-02-28 - Pre-compile Intl.Collator for locale-aware sorting
**Learning:** Calling `String.prototype.localeCompare` inside a tight `.sort()` loop is a major performance bottleneck because it implicitly instantiates a new `Intl.Collator` on every comparison. When options like `{ numeric: true, sensitivity: 'base' }` are added, the performance hit is even more severe. Additionally, when using `sensitivity: 'base'`, `toLowerCase()` is unnecessary as the collator handles case-insensitivity natively.
**Action:** When performing locale-aware sorting of large arrays, always pre-compile an `Intl.Collator` instance at the module level and reuse its `.compare` method inside the `.sort()` callback. This yields ~40x speedups in this codebase. Furthermore, replace `.replace(/^\./, '')` with `charCodeAt(0)` and `slice(1)` in hot paths to avoid regex compilation and string allocation overhead.

## 2026-03-01 - Branch Prediction optimization over Loop Unrolling in String Scan
**Learning:** For typical character loop scanning algorithms (like `isTextContent`), optimizing for the hot-path via branch prediction is faster and more readable than manual loop unrolling, which adds unneeded cognitive complexity. Structuring the check as `if (c < 32 || c === 127)` first bails out on the common case immediately.
**Action:** Before unrolling loops, test if separating an inexpensive fast path check from an expensive fallback check yields comparable or better performance via V8 optimizations.
