# Provider call warnings — evidence

Supports `docs/agents/assistant-providers.md` § "Provider call warnings are surfaced on the turn". Why the capture sits under Mastra at the model, and the coverage boundary it states.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 2289-2353); append rather than
rewrite.

---

`warnings` is a whole provider signal, not a sampling-param detail. The spec's
`SharedV4Warning` union carries four shapes — `unsupported` and `compatibility`
(`feature` + optional `details`), `deprecated` (`setting` + `message`), and
`other` (`message`) — and an adapter may add more. Brainstrike consumes the
CHANNEL: nothing filters by `type`, and the two text fields are read by FIELD
NAME, so an unrecognized type still produces a row.

**Where the capture lives, and why it cannot live on the Mastra stream.**
Measured against the installed `@mastra/core` 1.64, not assumed:

- On a STREAMING call the adapter reports its warnings on the first stream part,
  `{type:'stream-start', warnings:[…]}`.
- Mastra DISCARDS that part: `convertFullStreamChunkToMastra` returns
  `undefined` for `stream-start`, so it never becomes a `fullStream` chunk.
- Mastra's own `step-start.payload.warnings` is fed from `stream.warnings` on
  the doStream RESULT — a field the v4 provider spec does not define — so it
  arrives `[]` on every hosted provider.

A consumer written against `step-start.warnings` would therefore be a mapping
that can never fire. The observer instead sits UNDER Mastra, at the model:
`wrapModelWithCallWarningCapture`
(`packages/agent/src/providers/provider-call-warnings.ts`) proxies
`doStream`/`doGenerate` and records what the adapter reports, then
`createMastraAgentRuntime` hands the wrapped model to the supervisor and
inherited personas. Pinned persona instances are wrapped at creation against
the SAME per-run sink (BST-1745), so child and parent warnings share the
deduplication and capacity bound. Each warning retains its configured provider/model
in visible text and metadata, and deduplication includes that identity. It is an
OBSERVER: call arguments and stream chunks pass through untouched, which is what
keeps the "never sent on a default request" ruling above intact. Do not turn it
into a transform — `prompt-transform-proxy.ts` is the seam for that.

**Coverage boundary, stated.** `createProvider` returns a model INSTANCE for
every hosted provider plus the built-in local runtime, and a Mastra model
DESCRIPTOR (`{id, url, apiKey}`) for `ollama` and `lmstudio`. Mastra builds those
two models itself, so there is no Brainstrike-owned seam to wrap those models.
Every assembled run still owns a sink: a descriptor parent can delegate to a
hosted pinned persona whose warnings must be observed. The descriptor itself is
narrowed explicitly rather than wrapped into a proxy that could never observe
anything. Descriptor-model warning capture remains tracked in BST-1740.

The sink bounds every provider-controlled field with the shared
`boundRunEventReason` redaction/200-code-point contract before retaining it for
deduplication, including model identity; string-shaped warnings preserve their
explanation. All warning types share the existing 20-entry cap; accepted entries
are never evicted. Distinct model origins consume separate slots in that same
cap. A warning
recorded before exceptional stream termination is drained before the original
error propagates, even if Mastra never yielded a mapped part. Terminal
settlement also drains after child terminal publication, on both success and
error paths, before downstream consumption ends.

The rows themselves — kind `provider.request.warned`, `status: 'failed'`,
always-visible, one row per DISTINCT warning per run — are specified in
docs/agents/assistant-persistence.md. Paired tests:
`packages/agent/src/__tests__/provider-call-warnings.spec.ts` (the REAL
`@ai-sdk/anthropic` adapter dropping `temperature`/`topK`/`topP` on
`claude-opus-5`, captured through the production `createProvider`),
`packages/agent/src/mastra/__tests__/provider-warning-run-events.spec.ts`
(presentation, including a warning type the label table has never seen),
`packages/agent/src/__tests__/provider-warning-stream-errors.spec.ts` (terminal
and exceptional attempt drains, including a consumer that stops at finish), and
`packages/agent/src/__tests__/provider-warning-run-events.integration.spec.ts`
(the whole chain through the real Mastra loop — the test that would have caught
the `step-start.warnings` non-fix).
