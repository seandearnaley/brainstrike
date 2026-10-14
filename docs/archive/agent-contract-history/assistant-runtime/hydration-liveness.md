# Hydration liveness — evidence

Supports `docs/agents/assistant-runtime.md` § "ACTIVITY GROUPS".
Read before adding an animated indicator or changing run-event row status on a reloaded thread.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 2049-2066), extracted verbatim.

HYDRATION LIVENESS (do not relitigate): every animated "still happening"
indicator carries `data-live="true"` (`BrainstrikeThinkingMark`,
`AssistantThinkingIndicator`, the subagent pulse), and
`assistant-hydration-liveness.test.tsx` asserts a reloaded thread renders NONE
unless a pause is genuinely pending. Part-derived status is safe by
construction (hydrated messages are `complete`, so a resultless tool call
inherits it). Run-event rows are the hazard: a `running` row whose owning
message has settled resolves to the renderer-only `'interrupted'` status
(`AssistantRunEventDisplayStatus`; never persisted) unless a
`brainstrike.tool-approval` / `brainstrike.tool-suspend` data part for the same
`toolCallId` exists in the thread — the live notice, or the synthetic message
`appendSuspendedPauseMessages` re-appends for a still-suspended pause. An
ABSENT message status is left alone: liveness is never guessed. Subagent child
rows follow the same rule (`readLiveSubagentToolRowsFromMessages`). Between
history hydration (messages land `complete`) and `beginAssistantReplay`
removing the durable leaf it replays, an in-flight row can briefly read
"Interrupted" — the replay re-creates the message right after, so the window
is short and self-correcting.
