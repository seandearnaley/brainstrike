# Agentic summary call and metering — evidence

Supports `docs/agents/assistant-persistence.md` §
"Agentic summary call, projection, persistence, and metering". Read this before proposing to change the auxiliary runtime, the section schema, or the usage attribution.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

`projectCompactionMessages` is the plain-data counterpart of
`ToolProjectionRewriteProcessor`: prune markers always replace the stored
result, while supersession markers apply only when their superseder remains in
the provider-visible message set. Candidate selection happens after existing
compaction ranges are removed, and the summarizer prompt is serialized from
those already-projected candidates. Neither `toolInvocation.result` nor
`providerMetadata.mastra.modelOutput` can retain a rewritten raw result.

The auxiliary call uses `createMastraAgentRuntime` with the current trusted
provider/model transport but no memory, MCP, tools, personas, permissions,
hooks, task list, or compaction callbacks, then invokes the installed Mastra
`Agent.generate()` once with the fixed Goal / State / Decisions / Next / Files
touched instruction. The first occurrence of all five headers must appear in
order; content may begin on the header line after a colon, and later duplicate
header-shaped prose does not invalidate an otherwise complete summary. A
missing or out-of-order section is a schema failure and causes deterministic
fallback. Provider-reported `totalUsage` is required. Its
`AssistantChildRunUsage` is emitted as a `child-run-usage` chunk with
`source: 'compaction-summary'`, passes through
`persistDesktopChildRunUsage`, and is inserted under the parent `runId`.
Migration 090 and the renderer bootstrap widen the `run_kind` CHECK for that
value; estimates never enter this cost-accounting path.

On success, desktop saves an ordinary format-2 assistant Mastra message with
the fixed-section text and `brainstrikeCompactionSummary` payload, records that
message as a new root topology group, then calls `recordCompactionRange` with
the exact ordered candidate ids. Only schema validation failure or a stable
summarizer-side context-overflow code reuses the already-computed
candidate/protected set and commits a deterministic summary-shaped message.
Abort, rate limit, authentication, network, and other unclassified failures
leave history intact and return a no-op so a later turn can retry naturally.
Failures of the whole best-effort pre-request compaction facility do not prevent
construction of the user's real turn — and, since BST-1737, are no longer
invisible when they happen. See the next section.

