# R1 server boundary — evidence

Supports `docs/agents/mastra-boundary.md` § "R1 SERVER BOUNDARY". Read this
before changing what the scoped `Mastra` instance registers or before moving an
assistant HTTP concern. Verified 2026-09-21 and corrected inline: the quoted
`new Mastra({...})` literal now lives at `agent-runtime.ts:537` and also
registers a `backgroundTasks` block (retries 0, bounded timeouts); `if (!storage)
return {}` is `:531-533` and `mastra?.shutdown()` is `:1004`. The guard
(`scripts/__tests__/mastra-boundary-contract.test.mjs`) asserts only that
`server`, `observability` and `scorers` are absent, so `backgroundTasks` is not a
boundary break — the "no `workflows`" observation below is a snapshot of the 1.51
literal, not a rule.


**Mastra is used as an embedded library runtime. `Config.server` stays unset.
Brainstrike owns every assistant HTTP surface.**

The instance is a registration seam and nothing more —
`packages/agent/src/mastra/agent-runtime.ts:291-296`:

```ts
const mastra = new Mastra({
  agents: { brainstrikeAssistant: agent },
  ...(assistantMessageIdGenerator ? { idGenerator: assistantMessageIdGenerator.generate } : {}),
  logger: false,
  storage,
});
```

No `server`, no `workflows`, no `observability`, no `scorers`. It is constructed
**per request**, and `if (!storage) return {}` (`:285-287`) means hosted web never
constructs one at all. The only method ever called on it is `mastra?.shutdown()`
(`:535`).

Owned by Brainstrike, on both surfaces:

| Concern | Web | Desktop |
| --- | --- | --- |
| Entry | `apps/web/api/assistant.ts:8-24` → `apps/web/src/app/api/assistant/route.ts:29-70` | `startAssistantServer` / `handleAssistantRequest` in `apps/desktop/src/assistant-server.ts` |
| Auth | none per-request; env key only (`assistant-config.ts:3-7`), preview-gated | per-boot capability token, constant-time compare (`assistant-server/auth.ts:12-32`) |
| Origin/CORS | none in code | `hasDisallowedAssistantOrigin` → 403 before CORS headers (`handleAssistantRequest`'s origin gate in `assistant-server.ts` + `hasDisallowedAssistantOrigin` in `assistant-server/cors.ts`) |
| Body parsing | shared parser | shared limit + shared error type |
| Streaming | stateless (`packages/agent/src/stream/data-stream.ts:249`) | resumable sessions + `Last-Event-ID` (session create in `runAssistantTurn`, packages/assistant-service/src/run-turn.ts since BST-972 B3; the desktop transport pumps its Response + `resumeStreamIfAvailable` in `assistant-server/stream-resume.ts`) |
| Persistence | **none, deliberately** (`web-assistant-stream.ts:8-25`) | PGlite run/event/outcome tables (table consts in `assistant-server/run-persistence.ts`) |

