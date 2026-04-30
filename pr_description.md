💡 What: Replaced intermediate string allocations (`split`, template literals) with length/boundary checks and `indexOf` in path manipulation logic within `packages/selection-rules/src/engine.ts`.
🎯 Why: To reduce garbage collection overhead and improve execution speed in performance-critical hot loops when evaluating file selection rules and constructing tree hierarchies.
📊 Impact: ~50% to 60% reduction in processing time for tree traversal and deep path operations.
🔬 Measurement: Benchmarks run via terminal script confirm a reduction in implicit parent directories creation from 551.342ms to 218.992ms, and prefix depth calculation filtering from 361.716ms to 181.325ms.
