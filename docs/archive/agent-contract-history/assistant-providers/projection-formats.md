# Purpose-built projection formats — evidence

Supports `docs/agents/assistant-providers.md` § "Context-window-scaled default budgets". The line-oriented projections for grep, glob, read, exec, symbols, context and retrieval.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 4568-4732); append rather than
rewrite.

---

Oversized collections
(matches/entries/results/items/files/chunks/rows/subAgentToolResults) are
structurally trimmed; opaque outputs become a SUCCESSFUL
`tool_result_truncated` preview with an actionable hint. An opaque preview
retains a balanced 50/50 head and tail around an explicit omitted-character
marker, with both UTF-16 cut points snapped away from surrogate-pair interiors;
it no longer discards all trailing evidence. The legacy
`tool_result_too_large` envelope remains readable only for persisted-history
compatibility, and untrusted envelope-shaped output is revalidated against the
active budget. Proofs:
`tool-model-output.spec.ts`, `tool-output-limits.spec.ts`,
`projection-aware-token-limiter.spec.ts`,
`mastra-tool-execution.integration.spec.ts`,
`mastra-memory-persistence.integration.spec.ts`, and
`data-stream-session.spec.ts`. `listWorkspaceContext` is concise by default
(counts + token budgets); `detail: true` returns per-file Tapestry ranges.
`grepSearch` and `globWorkspace` keep their complete typed raw pages for
display, persistence, hooks, and reload, but their Mastra `toModelOutput`
projections are deterministic line-oriented text. Content mode returns NO
context lines unless the caller opts in (`contextLines` defaults to 0 —
BST-1193: searches locate, reads understand; the schema's `.describe()`
text and the tool fallback must state the same default — the inspector
display is derived from that schema (`toToolSchemaDisplay`, BST-1646), so
there is no longer a second mirror to keep in step). Since BST-1185 those
projections are PATH-GROUPED and happy-path-silent: one file header per file
(`rootName:path`, root prefix only when the producer's `openRoots` reports
more than one open folder — the display name is a valid `root` selector, and
two same-named roots fall back to root ids), then `line: text` rows with `-`
marking context rows; files mode emits `rootName:path:firstLine (N matches)`
per line. Engine/limit flags (`live=`, `candidates_truncated`,
`scan_limited`, `skipped_lines=`) appear in the header ONLY when they fire;
the read recipe lives once in the grepSearch/globWorkspace tool descriptions
instead of a per-row `read_args` envelope (the legacy per-row format cost
~180 chars/match). Continuation guidance is unchanged and authoritative, and
everything fits the 6000-character domain budget. Stored projections from
pre-BST-1185 threads still carry the legacy `grep <mode> | page=` header; the
replay prefix is the common prefix of both generations, so they replay
byte-for-byte.
Because Mastra's one-argument projector receives the raw result but not the
original tool input, paging guidance tells the model to reuse the prior call;
it never fabricates or duplicates the original pattern. When the whole raw page
fits, the projection preserves the producer's bounded hint because the producer
owns service caps and scan-limit semantics. Only when the tighter projection
budget omits raw page items does the projector calculate an earlier advancing
`offset`. Producer guidance includes an `offset` only when that offset strictly
advances; when search or candidate limits yield an empty page with no reachable
next offset, it instead gives terminal query-refinement guidance. A truncated
result without producer guidance throws instead of guessing. Match lines and
context are clipped with an explicit omitted-character marker; paths and root
labels are NEVER clipped or whitespace-collapsed (a mangled selector is
unusable) — a pathological oversized selector overflows the budget and its
item is omitted with an advancing offset. Root-name ambiguity is decided by
the PRODUCER against the full open-root inventory (`ambiguousRootNames` on
the envelope; `describeOpenRootTopology`), never page-locally. SETTLED
filename-forgery ruling (PR #2313): line breaks and a leading whitespace
character in paths are escaped, so a hostile filename can never create a new
projection line nor mimic an indented match row; a filename that merely
resembles a header or continuation string still renders inline on its own
single line and is an accepted residual — do not reintroduce per-row quoting
to chase it. The grep producer and projector
share one runtime result contract. The projector also recognizes its own
canonical bounded text envelope when Mastra replays a stored model projection
while preparing a later same-run step; that replay is idempotent and does not
reparse the text as a raw grep result.
`readWorkspaceFile` keeps its complete typed raw result for display,
persistence, hooks, and reload. Its projection-contract raw result fields now
include `openRoots`, `ambiguousRootNames`, and `rootId` in place of the removed
always-null `tokenCount`; the separate raw `approxOutputTokens` estimate remains
outside that projection contract. Its Mastra `toModelOutput` projection emits
a compact `read <root:>path lines <start>-<end>/<total>` header, prefixing a
root selector only when `openRoots > 1`. An unambiguous display name is the
preferred selector; a name listed in producer-owned `ambiguousRootNames` falls
back to `rootId`, matching the full-inventory `describeOpenRootTopology`
policy. Line breaks in both the selector and path are escaped so neither can
forge protocol lines. The page's already-gutter-prefixed content follows
verbatim; the native mutation-side refusal for accidentally pasting that
display form back into file content is specified in
`assistant-runtime.md` under "GUTTER-PREFIX WRITE GUARD (BST-1202)". The header
adds `size` and `omitted` only for a truncated page. A
`continue: cursor=<nextCursor>` footer appears only when a continuation cursor
exists: never when the request fit completely, and never in the registry-less
internal read mode where truncation can occur without an issuable cursor. The
same compact formatter backs the producer's self-fit binary search. It admits
more source content because the single header and optional footer replace the
raw result's fixed metadata-key and object-punctuation overhead; JSON escaping
does not free character-budget room. Its literal wire newlines instead save
model tokens. A stored `{type:'text',value}` beginning with `read ` on a later
same-run step replays byte-for-byte instead of being reparsed as a raw result,
mirroring the grep/glob replay contract. Legacy stored
`{type:'json',value:<raw result>}` projections are unwrapped and re-rendered in
the new text form, and legacy raw results without topology fields degrade to an
unprefixed header without losing content. Nothing else read `tokenCount`, so
the always-null field was dropped from the result entirely.
`executeCommand` keeps its typed raw result for display, persistence, hooks,
and reload; the envelope now carries the selected `rootId` plus the same
producer-owned `openRoots`/`ambiguousRootNames` topology used by workspace
reads. Its Mastra `toModelOutput` projection emits
`exec exit=<code|null> <seconds>` followed by only active `timed_out`,
`killed=<signal>`, `truncated`, and multi-root `root=<selector>` tokens.
Ambiguous display names fall back to the root id and selector line breaks are
escaped. The only exit-code
annotations are the conservative static cases `grep`/`rg` exit 1 (`no
matches`) and `diff` exit 1 (`files differ`); naive leading-token basename
extraction deliberately does not interpret shell prefixes or environment
assignments. Already ANSI-stripped, head+tail-fitted stdout and stderr are
rendered verbatim, with a `[stderr]` section, an explicit `(no output)` body,
and the producer truncation hint last when present; the projector never
double-truncates either stream. Legacy raw results without topology remain
valid and unprefixed, stored `exec ` text projections replay byte-for-byte,
shape rejection uses the dispatcher fail-soft marker, and either fresh or
replayed output above the 6000-character domain budget throws. Proofs:
`execute-command-model-projection.test.ts` and
`execute-command-tool.integration.test.ts`.
`findWorkspaceSymbol` and `lspInspect` keep their complete typed raw results for
display, persistence, hooks, and reload while their Mastra `toModelOutput`
projections emit bounded line-oriented inspection summaries. Symbol output
retains the root/path, 1-based declaration line and enclosing range,
declaration text, preview, total/truncation state, and honest instructions for
passing the returned unique identifier directly or forming the `lspInspect`
cursor marker when that identifier repeats. It does not invent a symbol
kind or the original symbol query: Mastra's one-argument projector receives the
raw result but not the original input. LSP output retains availability/reason,
language, hover text, diagnostics, and definition/implementation locations.
Projection-only omissions are counted explicitly, malformed result shapes
throw, and raw tool results are never mutated.
`listWorkspaceContext` likewise keeps its complete typed raw result for
display, persistence, hooks, and reload while its Mastra `toModelOutput`
projection emits a bounded line-oriented inventory. It retains the main and
other roots, focused-root id, selected-file page and outside-workspace count,
index state, token estimates, concise curated-token totals, and detailed
Tapestry ranges when requested. It reserves one advancing selected-file entry,
then fits the multi-root inventory before spending the remaining budget on
selected paths, so a large selection cannot hide the root ids required by
follow-up tools. Path rendering preserves repeated and boundary whitespace;
only line-breaking characters are escaped and overlong paths are explicitly
clipped. Projection-only omissions are explicit. When the projection cannot
retain the whole producer page, its continuation uses the exact advancing
selected-file offset; malformed, incoherent, or non-advancing producer results
throw instead of falling back to generic JSON.
An authoritatively resolved zero-root Desktop workspace is a successful compact
result with `workspaceRoots: []`, null main/focused identities, and an explicit
`roots=0` model line. An absent or malformed root-resolution result still fails
visibly and is never coerced to that valid empty state.
`queryEmbeddingSpace` and `hybridSearch` retain their typed raw results while
purpose-built Mastra projections emit bounded workspace evidence. Semantic
retrieval keeps the producer's canonical ranked, root-qualified context string
plus compact score and token-budget state; explicit clipping reports omitted
characters and a refinement action. Hybrid retrieval retains fused rank,
root/path, chunk identity, RRF/vector/FTS provenance, bounded excerpts, source
coverage, and producer-owned truncation guidance; path rendering preserves
repeated and boundary whitespace while escaping line breaks. Unavailable
Workspace Index state remains visible, malformed or incoherent results throw,
and neither projection mutates the execute result.
The execute-backed Tavily `webSearch` tool likewise retains its normalized raw
result for display, persistence, hooks, and reload while its Mastra
`toModelOutput` emits a bounded ranked-citation list. The projection retains the
query, availability/error state, producer count/truncation guidance, stable
rank, title, exact citation URL, and bounded snippet. Citation URLs are
JSON-escaped but never clipped or summarized: a citation is admitted whole or
omitted whole, with explicit projection omission and query-refinement guidance.
Malformed or incoherent results, including truncated producer output without a
hint, throw visibly. Provider-native Anthropic/OpenAI web search remains owned
by the provider adapter and does not pass through this execute-backed Tavily
projector.

