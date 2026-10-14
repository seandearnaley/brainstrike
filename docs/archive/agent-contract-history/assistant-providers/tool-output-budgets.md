# Tool output budget contract — evidence

Supports `docs/agents/assistant-providers.md` § "ASSISTANT SEARCH TOOLS". Token-denominated budgets, the domain/generic split, and the two projector throw contracts.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 4135-4238); append rather than
rewrite.

---

Tool output budget (anti-thrash contract): budgets are token-denominated at 4
chars/token (mirrors `countTokensHeuristic`). The two default budgets are
resolved once per Mastra run from the active model context window; explicit
per-tool overrides remain fixed and authoritative. Native producers self-bound
result lists via `fitItemsToCharBudget`. Purpose-built domain projections
(`readWorkspaceFile`, `grepSearch`, `globWorkspace`, `querySelf`,
`findWorkspaceSymbol`/`lspInspect`, workspace-context, and
workspace-retrieval, plus `webSearch` and `webExtract`) use decoded text length
for their self-fit contract. `MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET` is the
6000-character 128k anchor definition, not a universal per-run value. Desktop
projectors now self-fit against the run's resolved domain value; the fixed
constant remains the backward-compatible fallback only when no resolved budget
was threaded by a harness or nonstandard host.
`decodedWorkspaceTextModelOutputChars` counts code points in the value the
model actually reads and adds the small fixed
`PROJECTION_ENVELOPE_RESERVE_CHARS` reserve; it does not measure
`JSON.stringify(...).length`. A newline therefore costs one character, not
two, so line-dense pages fit roughly twice as much content at the same budget
as they did before BST-1195. The generic/default non-domain projection path
and the `boundToolOutputForModel` transport guard still measure serialized JSON
characters. The generic model-result ceiling remains 8000 characters; the
transport default is the resolved per-run value described below.
If the requested page exceeds the envelope, it shortens the page and returns a
26-character random `nextCursor` handle that resumes at the exact source line
and column, including within a long generated/minified line. The authoritative
root id, path, requested range, byte size, mtime, and source position remain in
the main-process registry and are never echoed through the model. Handles are
bound to the originating assistant resource/thread, expire after one hour,
survive renderer reload while the desktop main process remains alive, and are
cleared by factory reset or process restart. A handle is released only after its
continuation page has been validated and built successfully, before the next
handle is issued, so failed reads remain retryable while completed pages do not
occupy registry capacity for the rest of the TTL. Malformed, unknown, expired,
released, cross-thread, cross-root, and stale-file continuations fail visibly;
there is no legacy-cursor decode or fresh-read fallback. `omittedChars` counts
exact unread source characters; when a page ends after a complete line, that
includes the source newline before the next line.
Desktop reads each page from one containment-checked file handle: the same
handle is statted before and after the read, binary-probed, and decoded as fatal
UTF-8 in 64 KiB chunks. It retains only page-sized source fragments plus line
and character counters; it still scans to EOF because `totalLines` and
`omittedChars` are exact public metadata, never estimates. Full-file allocation
remains reserved for consumers that require the complete source, such as symbol,
LSP, and tapestry-range processing.
Pass `nextCursor` back unchanged as `cursor` with optional `maxChars` and no
other fields. `path` and `root` are initial-read inputs only and non-null
continuation overrides are rejected. A provider-emitted replay of the original
`startLine` or `endLine` is tolerated only when it exactly matches the
registry-bound range; a changed range fails visibly.
Optional
cursor, range, root, and character-cap fields accept provider-emitted `null` as
omission; invalid non-null values still fail schema validation. Both fit
`NATIVE_TOOL_RESULT_TOKEN_BUDGET` (2750) before settlement. The Mastra
runtime then adds or composes `toModelOutput` on every execute-backed
native/MCP tool. PostToolUse context travels only in an internal execution
carrier: Mastra's `transform.display` and `transform.transcript` channels
restore the exact domain result before live UI or durable persistence, while
`toModelOutput` alone consumes the context. Generated/default projections are
bounded to `MAX_MODEL_TOOL_RESULT_TOKENS` (2000) / 8000 serialized characters —
EXCEPT for tools that self-bound their complete result to
`NATIVE_TOOL_RESULT_TOKEN_BUDGET` and rely on the generic projection
(runPython, runSkillScript, skill_read, skill_search, plus the
`fitItemsToCharBudget` default-budget callers without custom projectors —
manageTaskList, readWorkspaceDirectory, queryDiagnostics; the
`skill` activation keeps its dedicated 6000-token envelope; `executeCommand`
has its own text projection — BST-1201 below — and keeps its override entry
only for the dispatcher fail-soft fallback). Those are
enumerated in `MODEL_PROJECTION_BUDGET_OVERRIDES`
(packages/agent/src/mastra/tool-model-output.ts) with the wider
`NATIVE_SELF_BOUND_*` envelope: 2x the native budget plus the structural
reserve, sized for worst-case JSON re-escaping of an embedded serialized
payload, so the tool's own head+tail retention and truncation hints (BST-1189)
pass through the default projector unmodified instead of being replaced by the
generic prefix preview. Regression guard:
`packages/agent/src/__tests__/tool-model-output.spec.ts`, "self-bounded native
tool results".
Purpose-built domain projections have a stricter resolved contract so the
remaining envelope can carry PostToolUse guidance. The
`MAX_DOMAIN_MODEL_TOOL_RESULT_TOKENS` (1500) / 6000-character constants define
the 128k anchor tier. Domain projectors MUST
self-fit a complete page; central code throws on overflow instead of
prefix-truncating a page whose continuation/provenance it cannot understand.
Only generated/default projections may use the generic truncation path.
Projector throws are two different contracts, distinguished by an explicit
marker (2026-08-03: a failed tool's value reaching the grep projector turned
into a fatal run error that destroyed the underlying diagnostic). A projector's
SHAPE-VALIDATION paths — "this value is not my tool's result at all" — throw
`ToolProjectionInputRejectedError` from `@brainstrike/agent`; the runtime
dispatcher degrades ONLY that marker to the generic bounded projection and logs
`tool_model_projection_fail_soft` with a keys-only shape summary that names the
trigger. Every OTHER projector throw is deliberate contract enforcement — a
limited result without continuation guidance, a non-advancing page, a self-fit
budget guard — and still fails the run, whether thrown inside the projector or
raised centrally on an oversized returned value. When adding a projector,
choose per throw site: marker for "not my result", plain error for "my
producer violated its contract".
Mastra's tool-input/output validation failure carrier
(`{error: true, message, validationErrors}` — `@mastra/core` `ValidationError`)
never reaches domain projectors at all (BST-1249): the dispatcher routes it to
the generic bounded projection alongside guarded tool errors, both bare and
nested under the AI-SDK `{input, output, toolCallId}` result envelope. It is an
EXPECTED shape for a mis-parameterized call, so it must not burn an
error-severity `tool_model_projection_fail_soft` — that log exists to flag
genuinely unexpected shapes (pinned in `tool-model-output.spec.ts`).
