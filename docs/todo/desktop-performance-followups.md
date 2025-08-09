# Desktop Performance Follow-ups (post PR #305)

- [ ] Extract background deepening into dedicated utility/hook and tighten cancellation to avoid races.
- [ ] Revisit cache vs UI state sync in `setFileContentsBatch` to enforce single source of truth.
- [ ] Add retry/backoff for worker file read errors and surface errors to UI.
- [ ] Add lightweight metrics (cache hit rate, load times) and consider code-splitting heavy paths.
- [ ] Confirm ARIA relationships for virtualized tree; add docs for BFS expansion and eviction.

Context: captured from Claude review on PR #305.