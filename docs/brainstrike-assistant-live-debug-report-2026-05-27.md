# Brainstrike Assistant Live Debug And UX Report

Date: 2026-05-27

Scope: Desktop assistant investigation using `pnpm --filter @brainstrike/desktop dev:agent-debug`, a main-profile DevTools-enabled Desktop launch, Electron CDP/Playwright inspection, live GPT-5.2 chats, runtime stream monitoring, terminal logs, and source review. This was a research/debug pass only. No app code was changed.

## Executive Summary

The reported "chat cuts off and just stops responding" behavior reproduced during a live GPT-5.2 run.

The strongest root-cause candidate is not the main GPT-5.2 provider stream itself. The main response streamed partial content successfully, then the run hit an error in Mastra observational memory:

```text
Could not find API key process.env.OPENAI_API_KEY for model id openai/gpt-5.2-chat-latest
```

That failure happened while observational memory was enabled and configured with `openai/gpt-5.2-chat-latest`. The visible chat UI did not show a useful terminal error state. The user sees partial assistant text, repeated collapsed "Thinking" blocks, and an idle composer.

After temporarily disabling observational memory in the active Desktop profile, GPT-5.2 completed long tool-heavy runs cleanly:

- Run 2: 66.3s, 188 KB streamed, `finishReason: "stop"`, `run.finished`.
- Run 3: 38.8s stream duration, 40 KB streamed, `finishReason: "stop"`, `run.finished`.

This does not prove memory is the only cutoff cause, but it is a concrete reproduced failure path.

Correction from follow-up verification: the first `dev:agent-debug` launcher used a temporary DB root, but the Electron `userData` override only applies in Electron E2E test mode. The ElectronStore-backed preference change was therefore not fully isolated. I removed the temporary memory preference override afterward and verified the main profile returned to the default observational-memory-enabled state.

## Live Environment

Command:

```bash
pnpm --filter @brainstrike/desktop dev:agent-debug
```

Observed DevTools endpoint:

```text
http://127.0.0.1:9222
```

Electron renderer target:

```text
BrainStrike Desktop - Home
http://localhost:38181/
```

The app opened with the assistant visible. The initial selected model was `Gemma 4 E2B`; I switched it to `GPT-5.2` through the model picker.

Follow-up main-profile verification:

- `window.secrets.list()` returned `["openai"]`.
- The model selector showed `GPT-5.2`.
- Shell environment checks showed `OPENAI_API_KEY`, `BRAINSTRIKE_OPENAI_API_KEY`, and `BS_OPENAI_API_KEY` were unset in the launching shell.
- Main-profile memory preferences returned to observational memory enabled after removing the temporary override.

## Code Paths Reviewed

Primary runtime and UI files:

- `packages/app-shell/src/assistant-chat-panel.tsx`
- `packages/app-shell/src/assistant-ui-panel-wrapper.tsx`
- `packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts`
- `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx`
- `packages/ui/src/assistant-ui-panel/overrides.css`
- `packages/ui/src/assistant-ui-panel/tool-fallback.tsx`
- `packages/ui/src/assistant-ui-panel/assistant-run-timeline.tsx`
- `apps/desktop/src/assistant-server.ts`
- `apps/desktop/src/assistant-server/http.ts`
- `apps/desktop/src/provider-api-key.ts`
- `packages/agent/src/mastra/agent-runtime.ts`
- `packages/agent/src/mastra/runtime-configuration.ts`
- `packages/agent/src/pglite-mastra-memory/memory-factory.ts`
- `packages/assistant-contract/src/memory-settings.ts`

## Reproduced Cutoff

Prompt used:

```text
Use your available repository tools if you have them. Inspect the Brainstrike assistant implementation enough to explain the streaming path end to end: composer -> runtime -> desktop assistant server -> provider -> tool/run timeline -> UI render. Then identify three likely places a GPT-5.2 response could appear to cut off or stop responding. Be specific and cite file paths you inspected.
```

Visible behavior:

- The user message appeared.
- Multiple collapsed "Thinking" sections appeared.
- The assistant started writing a useful answer.
- The visible answer cut off mid-section.
- The composer returned to idle.
- No clear user-facing error banner explained the interruption.

Terminal evidence:

```text
Error in agent stream {
  error: Error: Could not find API key process.env.OPENAI_API_KEY for model id openai/gpt-5.2-chat-latest
  runId: 'f03b5eac-253c-4637-a484-f116262971b8',
  provider: 'openai',
  modelId: 'gpt-5.2-chat-latest'
}
```

The same error appeared more than once for the run.

## Why This Points To Observational Memory

The main selected chat model was `GPT-5.2`, and the main response began streaming. The failing model id was different:

```text
openai/gpt-5.2-chat-latest
```

That model target matches the default observational memory model:

```ts
observationalMemory: {
  enabled: true,
  modelTarget: 'openai/gpt-5.2-chat-latest',
  scope: 'thread',
  messageTokens: 30_000,
  observationTokens: 40_000,
  retrievalMode: 'off',
}
```

Source: `packages/assistant-contract/src/memory-settings.ts`.

The memory factory passes that target into Mastra memory:

```ts
observationalMemory: buildObservationalMemoryOption(memorySettings.observationalMemory)
```

Source: `packages/agent/src/pglite-mastra-memory/memory-factory.ts`.

Desktop provider keys are resolved in `apps/desktop/src/provider-api-key.ts`, then passed into the runtime. But the memory model target includes a provider prefix (`openai/...`), and Mastra's internal model gateway tried to resolve `process.env.OPENAI_API_KEY` for it. That is a separate key path from Desktop keychain resolution.

## Memory Toggle Test

I temporarily disabled observational memory to isolate the main provider stream from the memory side effect:

```json
{
  "observationalMemory": {
    "enabled": false,
    "modelTarget": "openai/gpt-5.2-chat-latest",
    "scope": "thread",
    "messageTokens": 30000,
    "observationTokens": 40000,
    "retrievalMode": "off"
  },
  "semanticRecall": {
    "enabled": false,
    "embeddingModelTarget": "openai/text-embedding-3-small",
    "scope": "resource",
    "topK": 5,
    "messageRange": 2
  }
}
```

After that, GPT-5.2 completed long responses without the terminal API-key error. I then removed the temporary preference override so the active profile returned to its default memory settings.

Completed run evidence:

```json
{
  "status": 200,
  "ended": true,
  "error": null,
  "totalBytes": 188258,
  "durationMs": 66299,
  "finishReason": "stop",
  "outputTokens": 3144
}
```

## Hidden Context And Token Load

A separate UX/performance problem showed up during the long conversation. By the third prompt, the outgoing request was very large:

```json
{
  "bodyBytes": 150090,
  "messageCount": 6,
  "messageChars": [451, 689, 1486, 133207, 12122, 456],
  "provider": "openai",
  "model": "gpt-5.2",
  "hasMemory": true,
  "selectedFileCount": 0,
  "hasSelectionFolder": true,
  "enabledNativeToolIds": [
    "brainstrike.readWorkspaceFile",
    "brainstrike.readWorkspaceDirectory",
    "brainstrike.listWorkspaceContext",
    "brainstrike.readWorkspaceContext",
    "brainstrike.updateWorkspaceContextSelection",
    "brainstrike.updateWorkspaceTapestrySelections",
    "brainstrike.listEmbeddingSpaces",
    "brainstrike.queryEmbeddingSpace"
  ]
}
```

Provider usage reported:

```json
{
  "inputTokens": 388078,
  "outputTokens": 1732,
  "finishReason": "stop"
}
```

The user sees a compact composer, but not enough visible context about the size and cost of what is being sent. This is a major UX gap compared with Claude. Claude makes the chat feel calm partly because context attachments and state transitions are visible and legible.

## Tool And Reasoning UX Observations

The tool/reasoning UI technically works, but it is too hidden and too technical.

Observed live UI:

- Multiple collapsed `Thinking` sections appeared in one assistant message.
- Each says: `Reasoning and tool activity are hidden from the final reply.`
- The latest expanded panel showed: `Used updateWorkingMemory Completed`.
- Tool details are hidden behind another expand button.

Relevant components:

- `LocalChainOfThought` in `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx`
- `ToolFallback` in `packages/ui/src/assistant-ui-panel/tool-fallback.tsx`
- `AssistantRunTimeline` in `packages/ui/src/assistant-ui-panel/assistant-run-timeline.tsx`

The current tool card pattern is implementation-first:

```text
Used updateWorkingMemory Completed
```

For users, this should become product-language:

```text
Updated working memory
Completed
```

or:

```text
Used 3 tools
Read assistant-ui-panel.tsx, checked run timeline, updated working memory
```

## Streaming And Motion Observations

Brainstrike already uses restrained motion:

- Tool cards and run timeline cards use Framer Motion layout transitions around `0.16s`.
- Long message expansion uses `maxHeight` transition around `0.18s`.
- Streaming text uses a blinking CSS caret.

Relevant CSS:

- `.bs-streaming-caret`
- `.aui-thread-viewport`
- `.aui-composer-root`
- `.bs-composer-shell`

This is directionally aligned with Claude's short micro-motion model, but the state hierarchy is weaker:

- No strong first-token/no-token status.
- No always-visible activity summary while tools are running.
- Stop state exists, but the composer does not clearly communicate what is happening.
- Errors can terminate a partial response without an inline terminal banner.

## UX Gaps Compared With Claude

Claude patterns worth adapting:

- Assistant messages read as document content, not as heavy cards.
- Tool/file/action details are visible only when relevant, but the current status is always understandable.
- The composer action swaps cleanly between send/stop while the rest of the composer remains stable.
- Thread state changes are explicit: share, edit, branch, stop, retry.
- Error/interruption states should be inline and local to the message, not buried in logs.

Brainstrike gaps:

- Tool activity is hidden behind repeated "Thinking" blocks.
- Terminal run state is not explicit enough.
- Context size is not visible near the composer.
- Very large hidden message/context payloads are easy to send accidentally.
- Thread history is collapsed by CSS rather than treated as a deliberate conversation fold.

## Recommended Fix Order

1. Fix observational memory key/model routing.

This is the reproduced cutoff bug. Observational memory must not use a provider-prefixed Mastra model target that bypasses Desktop keychain resolution. Options to evaluate:

- Use non-prefixed OpenAI model ids for OpenAI memory models when invoking Mastra memory.
- Pass the resolved Desktop provider API key into the memory model path explicitly.
- Disable observational memory by default until key resolution is reliable.

2. Add explicit terminal message states.

If a run errors, aborts, or ends without a clean finish, the assistant message should show an inline banner:

```text
Response interrupted
The run stopped before a final completion event.
Retry
```

For provider errors:

```text
Provider error
Could not complete memory observation because the OpenAI key was unavailable.
Retry without memory
```

3. Add an always-visible run activity header.

While running, show one compact status above the current assistant response:

```text
Working...
Reading files
Using tools
Writing response
```

This should be visible without expanding reasoning.

4. Redesign tool call cards.

Keep raw args/results collapsed. Show a friendly summary first:

```text
Read assistant-ui-panel.tsx
Completed
```

Group consecutive tools:

```text
Used 4 tools
3 completed, 1 updated context
```

5. Add composer context chips and token budget visibility.

Near the composer, show:

```text
GPT-5.2
8 tools enabled
Memory on/off
Workspace root selected
~388k input tokens
```

This is critical. A user should know when they are sending a massive prompt before it goes out.

6. Improve long-thread behavior.

Replace CSS-only hidden old messages with an intentional fold:

```text
8 previous messages collapsed
Expand
Search thread
Jump to latest
```

## Architecture Notes

This is better solved as an architecture/contract cleanup, not only a UI patch.

The current assistant experience spans:

- Desktop server key resolution and stream lifecycle.
- Mastra runtime and memory side effects.
- Assistant UI runtime state.
- Tool/run event rendering.
- Workspace context packing.

The cutoff fix should establish a clear invariant:

```text
Every assistant run must end in exactly one visible terminal state:
completed, stopped, interrupted, failed, or retried.
```

And:

```text
Post-response side effects, including memory observation, must not silently corrupt or truncate the visible assistant response.
```

## Evidence Summary

Reproduced failure:

- GPT-5.2 main response started.
- Visible response cut off.
- Terminal logged Mastra memory API-key failure for `openai/gpt-5.2-chat-latest`.
- UI did not surface a clear error.

Isolation:

- Observational memory disabled.
- GPT-5.2 completed long tool-heavy runs.
- Stream ended cleanly with `run.finished` and `finishReason: "stop"`.

Secondary risk:

- Third run request body: about 150 KB.
- Provider-reported input tokens: 388,078.
- Context and long-thread payload size are not visible enough before send.
