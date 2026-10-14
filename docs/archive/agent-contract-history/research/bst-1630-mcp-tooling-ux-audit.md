# MCP and tooling audit — 2026-09-04

Ticket: BST-1630. This is a source snapshot and measured UX review, not a new
runtime contract. The living contracts remain in `assistant-providers.md`,
`assistant-runtime.md`, and `mastra-boundary.md`.

## Decision

Keep the embedded Mastra runtime and single desktop MCP authority. The concrete
opportunities are clearer discovery guidance, truthful enumeration state, and
less technical detail in the default Settings view. A harness rewrite is not
justified by this pass. Tool execution concurrency needs its own measured safety
work, already tracked by BST-1290.

The first follow-up implementation moves connection diagnostics behind a native
disclosure. It adds no network request, polling, persistence, package, or second
connection owner. Lifecycle controls, errors, and tool content stay visible.

## Reference snapshots

Both supplied checkouts were clean when inspected; no reference code was changed.

| Source | Commit | Inspected areas |
| --- | --- | --- |
| Codex | `4636819a352bfd4271c669c568a92f1bccfcd7e0` | Deferred search specification/handler/cache, source metadata, result exposure |
| OpenCode | `5cf9f517cfec3ef68d3e68a12a6a4b3163947f44` | MCP catalog, tool registry/schema conversion, validation errors, read-tool guidance, MCP selector UI |
| Brainstrike | `ae6fe0479f2b4267637a57d42ee83ccdd13e0972` before this layer | MCP actor/host, discovery processor, tool guards, Settings status/availability and catalog |

Mastra APIs were checked against installed `@mastra/core` 1.59.0 declarations.
Examples in another product are evidence to assess, not a contract to copy.

## Findings and disposition

### 1. Separate discovery from complete inventory — implemented in BST-1628

[Codex's search specification](https://github.com/openai/codex/blob/4636819a352bfd4271c669c568a92f1bccfcd7e0/codex-rs/core/src/tools/handlers/tool_search_spec.rs)
describes deferred metadata search and next-model-call exposure. It supplies
source context and a result limit. Brainstrike's three-hit Mastra search is
likewise retrieval, but the observed Linear model treated it as exhaustive.

The lower layer adds complete paginated inventory without schemas and makes the
search/result wording explicit. Keep that separation. Do not raise topK globally
to mask inventory questions or preload every MCP schema.

### 2. Tell the model which eligible sources exist — BST-1631

Codex deduplicates source names and bounds source-description text in the search
specification. Brainstrike's `deferred-capability-families.ts` correctly filters
native families by eligibility, while `buildSearchToolDescription` only adds
generic "MCP tools" for external sources. The model can enumerate tools after
calling inventory, but its initial source guidance is weaker.

Carry structured source identity through the eligible catalog and expose a small,
bounded source summary. Never derive identities by splitting sanitized names,
include denied capabilities, or create a cross-runtime catalog cache. Extend the
existing BST-638 evaluation machinery with Linear/Atlassian discovery cases and
measure token cost and final tool choice before tuning descriptions or ranking.

### 3. Show status and actions before diagnostics — implemented in BST-1630

[OpenCode's MCP selector](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/app/src/components/dialog-select-mcp.tsx)
prioritizes source name, status, errors, and connection controls. Brainstrike's
`mcp-server-status-row.tsx` exposed protocol policy, generation, OAuth metadata,
extensions, negotiation facts, and logs together with routine controls.

Preserve the diagnostic depth, but put it behind "Connection details". Use native
HTML disclosure semantics rather than another state machine. Keep server and
control errors, tool availability, catalog content, and recovery actions outside.
The host snapshot remains authoritative and disclosure creates no host call.
Review closure keeps stderr/client diagnostics visible in error and
authentication-required states without forcing the disclosure open. Healthy logs
remain collapsed. A generation-reset regression also verifies that ordinary
snapshot updates preserve expansion while a new generation resets it.

### 4. Connection is not tool readiness — BST-1632

`mcp-tools-availability.ts` explicitly documents an unresolved ambiguity:
handshake completion precedes catalog publication, and absent tools alone cannot
prove either failure or successful emptiness. Current warnings correctly require
positive `catalog.errors.tools` evidence.

This needs an architecture change at the host snapshot: authoritative enumeration
state per generation, followed by a UI projection. Adding a timer, spinner, or
zero-tools warning only in React would guess. Cover empty success, unsupported
tools, pending enumeration, failure, refresh, and stale-generation replacement.

### 5. Preserve server schemas and correctable errors — retain current approach

[OpenCode's MCP catalog adapter](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/mcp/catalog.ts)
forces `additionalProperties: false`, includes tolerant output-schema retry, and
can convert catalog failures to an absent result after logging. Those choices do
not satisfy Brainstrike's payload-fidelity and visible-failure contracts.

Retain server JSON Schema semantics, SDK protocol validation, and visible
per-server failures. BST-1628's explicit non-strict provider generation preserves
optional filters while runtime validation remains enforced. Do not strip null,
zero, or empty values after generation: they can be meaningful server arguments.

[OpenCode's tool wrapper](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/tool.ts)
distinguishes correctable validation errors from execution failures. Brainstrike
already has the corresponding trusted `ToolInputError` path and redacted generic
errors in `guard-tool-execution.ts`; preserve it rather than exposing arbitrary
server error text as trusted model guidance.

### 6. Performance work needs evidence and ownership — reuse BST-1290

[Codex's search handler](https://github.com/openai/codex/blob/4636819a352bfd4271c669c568a92f1bccfcd7e0/codex-rs/core/src/tools/handlers/tool_search.rs)
reuses a search engine only while source identity/metadata match, and opts that
handler into parallel calls. This is useful evidence for avoiding redundant
index construction, not proof that arbitrary MCP mutations may overlap.

Brainstrike has no explicit `toolCallConcurrency` configuration in current source.
The existing BST-1290 proposal covers that issue; its PR #2802 is closed and
unmerged, and the ticket is Backlog. Do not duplicate it or copy a concurrency
limit without measurements of database/worker contention and approval, suspension,
call-result correlation, and cancellation ordering. No performance gain is
claimed for search caching or concurrency in this layer.

### 7. Descriptions should teach input boundaries, not compensate for bugs

[OpenCode's read description](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/read.txt)
explicitly documents absolute paths, one-based offsets, truncation, and when to
use grep/glob. This supports using concise, discriminating guidance plus
behavioral evals. Brainstrike already owns native schemas/metadata centrally;
preserve those identities and cross-platform capability gates. Do not mass-rename
tools or rewrite server-owned descriptions merely to mimic a CLI vocabulary.

## Token economics — explicit user priority

Optimize total tokens per successful task, including retries and repeated tool
definitions, rather than the size of one successful-looking request. Keep usage
facts separate from model-specific price estimates and cache discounts.

Fresh `o200k_base` measurements used an instrumented copy of
`native-tool-prompt-budget.test.ts`, the real native registry/runtime, its existing
skills fixture, and the same normalized function serialization. No paid model
call was made. These are fixture tokenizer counts, not Linear schema totals or
provider-billed tokens.

| Measured surface | Tools | Tokens |
| --- | --- | --- |
| All authored native definitions | 39 | 9,490 |
| Critical native definitions only | 8 | 2,295 |
| Authored native tools plus fixture instructions | 39 | 10,362 |
| Mastra/OpenRouter core plus skills and instructions, before discovery controls | 11 | 4,730 |
| Same normalized payload plus processor-produced discovery controls | 13 | 5,081 |
| `search_tools` definition alone | 1 | 191 |
| `list_available_tools` definition alone | 1 | 164 |

The last two numbers are independently serialized arrays, so their sum need not
equal the combined payload delta at tokenizer boundaries. The augmented 5,081
measurement exposes a coverage gap: the existing 5,000-token core envelope is
checked before the discovery controls are added. It does not enforce the complete
initial request's size. BST-1633 should cover the actual post-processor provider
boundary and trim duplication before considering any budget change.

The next economic benchmark should separate definition, instruction, projected
result/history, output, uncached input, cache read/write, retry, and latency costs.
Include first use, repeated use, inventory enumeration, exact-name loading, and
approval/resume. Measure task success and argument validity alongside those costs.

Concrete candidates for that benchmark:

- Mastra auto-loads all returned matches (up to three); unnecessary definitions
  then remain append-only in the active context and can recur in later requests.
- Search results repeat descriptions; inventory returns up to 50 descriptions
  per page. Compare compact result projections and targeted enumeration while
  preserving disambiguation and explicit truncation/count semantics.
- Keep stable definition ordering where supported, but measure actual cache
  usage rather than assuming a stable map creates a billing discount.
- Filter and aggregate large intermediate data before model ingestion when the
  task permits it; preserve access to full artifacts and accurate failure states.

[OpenCode's truncation path](https://github.com/anomalyco/opencode/blob/5cf9f517cfec3ef68d3e68a12a6a4b3163947f44/packages/opencode/src/tool/truncate.ts)
stores full output and returns a bounded preview with a read/grep continuation
hint (defaults: 2,000 lines and 50 KiB). Brainstrike already has durable artifact
settlement and model projections; compare task-specific result sizes instead of
copying another product's byte limits. Its `code-mode.ts` also projects MCP
results and catalog instructions, but a new execution mode must satisfy the
existing orchestration correctness and authority gates.

Prior studies are historical evidence, not current price promises: BST-680 found
provider-native search used more tokens/cost in its paired cases, and BST-616
found large orchestration savings with an unacceptable first-run correctness
loss. Current adapters close some old API gaps, but only a fresh quality-and-cost
comparison can justify adoption. Do not equate newer, native, or shorter with
cheaper successful work.

## Verification of the first UX slice

Three new regression tests failed before their implementation, then passed along
with the existing Settings, OAuth-control, and extension tests: 97 tests total.
Malformed/unreadable credential notices also stay outside the disclosure, since
those faults can disable Connect and must remain immediately visible.

Measurements used the production `McpServerStatusRow` and app CSS in an isolated
Electron agent-debug renderer over CDP, with a synthetic OAuth snapshot. These
are component measurements, not a claim about a live server's availability.
The same fixed-width container and identical snapshot were used before/after.

| Actual row width | Before | Collapsed after | Expanded after |
| --- | --- | --- | --- |
| 624 px | 240 px | 86 px | 276 px |
| 344 px | 312 px | 122 px | 328 px |

Space opens and Enter closes the disclosure. The focused summary has a computed
2 px solid outline. Expanded content fits both widths without horizontal overflow;
Disconnect remains visible when collapsed. Unit tests also keep server errors
and Retry visible. Expansion does not execute a lifecycle control.

## Layer boundaries and follow-ups

- BST-1628 / #2962: complete inventory and optional input fidelity.
- BST-1629 / #2963: stored OAuth startup reconnect, based on #2962.
- BST-1630: this audit and disclosure UX, based on #2963.
- BST-1631: eligible source guidance; Backlog, child of BST-1630.
- BST-1632: authoritative enumeration lifecycle; Backlog, child of BST-1630.
- BST-1633: total token cost per successful task and post-processor budget coverage;
  High priority, Backlog, child of BST-1630.
- BST-1290: existing concurrency effort; reassess its previous closure before adoption.

Nearby code intentionally untouched: MCP transports/OAuth and host contracts,
tool execution/permission rules, provider adapters, native descriptions, database
schema, config persistence, and the supplied reference repositories. This pass
does not certify all MCP providers or compare overall product quality.
