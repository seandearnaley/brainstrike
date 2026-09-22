# Live shell output streaming — evidence

Supports `docs/agents/assistant-runtime.md` § "Renderer stream-insulation boundary".
Read before changing `executeCommand` output streaming, the shell-output chunk type, the renderer accumulator, or cwd validation typing.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 2109-2155), extracted verbatim.

Live shell output (executeCommand streaming): `executeCommand` streams its
subprocess stdout/stderr incrementally through Mastra's tool `writer` as it is
produced (a long build/test run is visible live, not only on exit). The tool
writes via `writer.custom({ type: SHELL_OUTPUT_STREAM_PART_TYPE, … })`
(`packages/agent/src/mastra/shell-output-stream.ts`), which places the slice on
the fullStream VERBATIM — deliberately NOT `writer.write` (that wraps it as a
`tool-output` part, colliding with subagent delegation and masquerading as a
successful tool result). `processMastraStreamPart` maps that part to a dedicated
transient `shell-output` StreamChunk; `DataStreamMapper.handleShellOutput` emits
it as a `SHELL_OUTPUT_DATA_NAME` aui-data part (subject to the SAME text-part
deferral). It is NOT a run-event kind ON PURPOSE: run-events are persisted
server-side into `assistant_run_events` (and their metadata is redaction-
sanitized, which strips `output`/`text` keys) — a `shell-output` StreamChunk is
ignored by that persistence tap (`chunk.type !== 'run-event'`), so live slices
are TRANSIENT (never persisted; absent on reload — the FINAL captured output
persists as the tool result). A COMBINED streaming cap
(`MAX_STREAMED_OUTPUT_BYTES`, separate from the 1 MB capture cap) stops a runaway
process flooding the stream: at the cap one truncation notice is emitted,
streaming stops, and teardown/capture continue unchanged. Mastra hands a plain
tool OBJECT the raw `outputWriter` fn + top-level `toolCallId` (a `createTool`
instance gets `writer.custom` + `agent.toolCallId`); the desktop wiring accepts
both. The renderer accumulates slices per toolCallId INCREMENTALLY
(`createShellOutputAccumulator` + `ShellOutputProvider`, via
`useChainActivityDerivations`) into the live tool card (`LiveShellOutputPane`,
shown only while running). The accumulator is O(new parts) per streamed update
and keeps record identity stable when no shell slice arrived — do NOT replace
it with a full rescan per update (`collectShellOutputs` is the pure/batch
variant): the full rebuild is quadratic over a chatty command and its
per-chunk fresh record identity re-renders every tool card in the turn. Same
rule for `ToolDurationProvider` (value-stable via `useStableRecord`).
`background:true` on the one-shot tool is not the persistence mechanism. The
desktop application-layer command-session manager below owns that lifecycle;
model exposure remains a separate permission/discovery slice. Proofs:
mastra-tool-execution.integration.spec ('streams incremental shell-output …'),
execute-command-tool.test / execute-command-live-loop.test, shell-output-parts.test.

executeCommand cwd validation is model-correctable BY CONTRACT: `resolveCommandCwd`
throws `ToolInputError` (never a plain `Error`) for a nonexistent cwd and for a cwd
that resolves outside the workspace root, so the per-tool guard surfaces the bounded,
actionable message as `tool_input_invalid` instead of redacting it into the generic
`tool_failed` text (a model that mis-specifies `cwd` must learn WHAT was wrong —
"does not exist" vs "outside the root" — not merely that the call failed). The same
typing applies to the workspace-root qualifier failures in `resolveWorkspaceRoot`
(no folder open, unknown/ambiguous root). Proof: the `runExecuteCommand — cwd
containment` cases in execute-command-tool.integration.test.ts (assert the
`ToolInputError` class AND message per failure mode, including the nonexistent-cwd
message that names the requested cwd).
