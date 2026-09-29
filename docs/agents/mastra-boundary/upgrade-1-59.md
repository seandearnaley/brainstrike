# 1.57 → 1.59 upgrade record — evidence

Supports `docs/agents/mastra-boundary.md` § "1.57 → 1.59 UPGRADE NOTES"
(2026-08-15, BST-1282). Read this before routing a tool decline through an error
status, or before retiring the OpenAI duplicate-item processor. The
`@mastra/memory` pin discussion this section opened onto has its own files:
`memory-pin-and-pglite-close-race.md` and `pglite-close-race.md`.



R6 did its job: the only compile-time break in this range was the sealed
disposition inventory rejecting one newly-added `ChunkType` member. Measured
diff — **exactly one added, none removed**.

**`tool-output-denied` → disposition `'mapped'` (REQUIRED, not optional).**
Payload `ToolOutputDeniedPayload` = `{toolCallId, toolName, args?,
approval:{id, approved:false, reason?}}`. Mastra emits it on the decline leg of
a `requireApproval` call (mastra #20886) so clients can RESOLVE the pending call
instead of hanging. It is the DECLINE terminal of the same lifecycle
`tool-call-approval` opens, and the tool never runs, so no later
`tool-result`/`tool-error` ever carries that id — `'ignored'` would strand the
renderer's tool part pending forever and leave the durable `tool.started`
unpaired, reproducing the exact hang upstream fixed.

**A decline is TERMINAL but it is NOT an error, and the two must diverge —
settled 2026-08-15 on review, do not collapse them again.** `tool-event-mapper.ts`
decodes the chunk to its OWN `StreamChunkTool` status, `'declined'`, carrying the
shared `DeclinedToolCallResult` envelope (`@brainstrike/assistant-contract/tool-approval`:
`{kind:'declined', message, reason?}`) as its `result`. Routing it through
`status: 'error'` instead settles the call but breaks three things:

| Routed as `'error'` | Why that is wrong |
| --- | --- |
| `handleToolError` records `pendingToolErrorTexts` | that map clears only on a later `text-delta`, so a denial that is the last chunk before `finish` (or a Stop right after it) emits "I couldn't complete the tool action because it failed: The user declined this tool call…" and finalizes the step as errored |
| the frame carries `isError: true` | `isError` is the destructive-chrome switch in `tool-fallback.tsx`; nothing broke |
| the result is a bare error string | strings short-circuit `readResultError (`activity-trace-model.ts`, shared by the card and the trace)`, so the card falls through to a GREEN Completed for a tool that never ran, and `narrowRunPythonDisplayResult` returns `null`, bypassing run_python's own muted declined surface |

`DataStreamMapper.handleToolDeclined` therefore settles the id (`toolCallResult`
+ `settledToolCallIds`) with the envelope and NO error flag, and queues no
visible failure text. `settledResultOverride` (`activity-trace-model.ts`)
reads the envelope and renders the
muted `stopped` treatment — the same one run_python already reserved for a
decline. Same ruling as the BST-558 resume-unsupported terminal (see
docs/agents/assistant-runtime.md, "The tool card is SETTLED").

The DURABLE run event deliberately keeps the `tool.failed` KIND and only
relabels to `Tool call declined`: kind is what `getMatchingFailedKind`,
`collectToolDurations`, and `RUN_LEDGER_AGGREGATION_SQL` close a call out on, and
here the call really is over. That is the OPPOSITE conclusion from
`tool.resume.unsupported` (BST-558) for the opposite reason — that pause stays
suspended and can still emit its real terminal later; this one cannot.

The part is dispatched through `mapToolLifecyclePart`, NOT `mapGenericToolEvent`:
a delegation tool (`agent-<persona>`) can be gated by an explicit global approval
gate, its `tool-call` has already emitted `subagent.started`, and the decline is
that delegation's only terminal — so it emits `subagent.failed`/`'cancelled'`
("Subagent delegation declined") and keeps the "never leave an orphaned
`subagent.started`" rule whole. Mutation-checked paired tests in
`mastra-tool-approval-chunks.spec.ts` (settlement + the silent-continuation case
that proves no false failure text) and `mastra-tool-lifecycle.spec.ts` (the
delegation terminal).

**R1/R2 re-verified.** 1.59 drops `@modelcontextprotocol/sdk` from
`@mastra/core` and adds `@modelcontextprotocol/server@2.0.0`. The new package is
**type-only** in the published dist: it appears exactly once, as `import type
{ ElicitRequest, ElicitResult, ServerContext }` in `dist/tools/types.d.ts:3`,
with zero `require`/`import` of it in any `.js`/`.cjs`. No HTTP surface is
gained, so R1 stands unchanged. Both browser bundles still externalize
`@mastra/core` and `/^@mastra\//`.


**Adopted deliberately later, not here.** `stepResult.rawReason` on
`step-finish`/`finish` preserves the provider's own finish reason instead of
collapsing to `'error'` — a direct upgrade for `stream-termination.ts` and
`provider-error-metadata.ts`, additive, and left as a follow-up. 1.58 also made
streams emit `error` chunks and invoke `onError` when a provider ends
`finishReason: 'error'` with no error payload; the existing `'error'` mapping
(`makeRecoveredProviderErrorTermination`) already covers that path and
`data-stream-stall.spec.ts` / `mastra-streaming.spec.ts` pass unchanged.

**The 1.59 shared-message-id fix does NOT retire the BST-1095 dedupe
processor.** mastra #21185 makes a streamed assistant message carry the same id
as its persisted copy, so a chat UI reconciling a live stream against refetched
history stops double-rendering one reply. BST-1095 is a different defect with
the same smell: `MessageList.add`'s sealed-boundary re-key persists a SECOND
durable row (`createdAt + 1ms`) so the prompt replays every `rs_`/`fc_`/`call_`
reference twice and OpenAI 400s. That re-key is still present verbatim in the
1.59 dist (`dist/message-list-*.js`, the two
`createdAt = new Date(existing.createdAt.getTime() + 1)` sites), and the
processor operates on the PROMPT, so it also protects threads whose twin rows
were persisted by older builds. `openai-duplicate-item-compat.ts` stays.

