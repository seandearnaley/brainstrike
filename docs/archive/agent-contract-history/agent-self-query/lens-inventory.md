# Lens grammar, invariants and shipped inventory — evidence

Supports `docs/agents/agent-self-query.md` § "Lenses (BST-921): retrieval strategy as a reviewable artifact".
Read before adding a lens, changing the lens grammar, or changing lens execution. Extracted verbatim from the pre-distillation contract.

A **lens** is a named, parameterized SQL file under `.brainstrike/lenses/`
(per mounted root, then `~/.brainstrike/lenses/` — the persona two-tier,
flat-scan, first-id-wins convention; loader:
`apps/desktop/src/assistant-server/lens-loader.ts`, grammar:
`packages/assistant-contract/src/lenses.ts`). Header grammar:

```sql
-- description: <required, one line>
-- param: <name> <text|integer|number|boolean> <optional description>
<SQL body; $1..$N in param declaration order>
```

Invocation rides `brainstrike.querySelf`: `mode: 'listLenses'` (invalid
files are listed WITH their parse errors — fail closed, never silent) and
`mode: 'lens'` + `lens` + `values` (positional strings, coerced by the
declared types).

Invariants (do not silently reverse):

- **Same sandbox, no elevation.** A lens executes through the identical
  four-layer preamble + admission as `mode: 'query'`. A lens file is
  untrusted repo content, exactly like a persona file.
- **Values only ever travel as bind parameters** — `AgentSqlService.query`'s
  `params` rides the extended protocol into BOTH the admission `EXPLAIN`
  (PGlite plans parameterized statements; planning with real values keeps
  the cost estimate honest) and execution. Never interpolate a value into
  lens SQL.
- **Placeholder discipline is a PARSE-time error**: the SQL's highest `$n`
  must equal the declared param count and every `$1..$n` must appear —
  an authoring mistake surfaces in `listLenses`, not as a runtime surprise.
- **Every lens ships with a golden test.** `callers-hybrid` (the BST-935
  canonical statement, parameterized on symbol + terms) is proven by
  `packages/db/__tests__/search-lens-callers-hybrid.test.ts`, which reads
  the ACTUAL checked-in file — the artifact is the single source of truth.

Shipped lens inventory (each with its golden test,
`packages/db/__tests__/search-lens-<name>.test.ts`, reading the checked-in
file):

| Lens | What it answers |
| --- | --- |
| `callers-hybrid` | BST-935 hybrid retrieval over a symbol's caller graph |
| `token-spend-by-tool` | per-tool model-facing chars, truncation, zero-match, pagination proxy over a window |
| `estimator-calibration` | estimator-vs-provider prompt-token ratio distribution by model and budget tier (BST-1205/BST-1219) |
| `run-outcome-tool-correlation` | tool usage × run-outcome verdict buckets with per-verdict run denominators (`verdict_total_runs`, `verdict_run_share`); unlabeled runs kept as their own bucket (BST-1240) |
| `self-improvement-signal` | top-N tools by `waste_score` — a RANKING HEURISTIC (chars × (truncation rate + zero-match rate)), not a char count (BST-1240). BST-1247: rates count MODEL-CONTROLLABLE waste only — substrate-degraded calls (js-walk fallback, scan/candidate caps) are excluded and reported as `substrate_degraded_rate` |
| `experiment-outcome-correlation` | run outcomes grouped by per-run experiment treatment (experiment, variant, signal injection + distinct content hashes); unlabeled runs kept visible (BST-1250) |

The BST-1240 lenses normalize `tool_id` before grouping
(`brainstrike.grepSearch` → `grepSearch`): the telemetry writer stores the id
verbatim (`toolNameMap.get(toolId) ?? toolId`), so one logical tool can land
under both spellings, and a split would halve a waste score and silently push
the worst tool out of the top N.

The opt-in [self-improvement signal injection](../../../agents/agent-self-query/workspace-context.md#self-improvement-signal-injection-bst-1241)
executes an app-owned copy of `self-improvement-signal`, pinned to the shipped
lens SQL body by a parity test; it never executes a workspace-scanned lens.
