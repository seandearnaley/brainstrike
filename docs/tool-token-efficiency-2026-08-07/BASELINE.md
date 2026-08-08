# Tool token-efficiency baseline

Capture the pre-P1 baseline after BST-1190 has been used during representative
assistant work. Choose one inclusive UTC window that contains the workload but
does not overlap a later format-change deployment; save the exact ISO `since`
and `until` timestamps with the result.

Run `brainstrike.querySelf` with:

```json
{
  "mode": "lens",
  "lens": "token-spend-by-tool",
  "values": ["2026-08-07T00:00:00.000Z", "2026-08-07T23:59:59.999Z"]
}
```

Save the returned rows unchanged as the pre-change artifact, along with the
Brainstrike commit, workload description, thread ids used, and window. The
table contains only counts, sizes, ids, and booleans; do not supplement the
artifact with search patterns, paths, file content, or command text.

After P1 or P3 merges, repeat the same workload in a non-overlapping window and
run the same lens. Compare each tool's `calls`, `total_model_facing_chars`,
`avg_model_facing_chars`, `truncation_hit_rate`, `zero_match_rate`, and
`pages_per_search_proxy`. Character savings should be compared only where call
mix and search rates are materially similar; otherwise report the changed mix
beside the before/after totals rather than attributing all movement to format.
