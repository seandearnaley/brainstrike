# Error processors, run errors and finish reasons — evidence

Supports `docs/agents/assistant-runtime.md` § "ASSISTANT RESILIENCE (CRITICAL)".
Read before changing the Mastra error-processor stack, the `metadata.runError` extractor, tripwire mapping, the HTTP 401 remedy copy, or finish-reason classification. BST-1384, BST-868.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 409-626), extracted verbatim.

4. **Mastra error-processor layer (LIVE)** —
   `packages/agent/src/mastra/error-processors.ts`, wired into `new Agent` +
   `buildToolLoopOptions` (`new Agent` in `agent-runtime.ts`; the tool-loop
   options in `runtime-assembly/stream-options.ts`, moved out of
   `agent-streaming.ts` by BST-1649). Adopts three `@mastra/core`
   built-ins that recover on EMITTED provider/API errors — disjoint from the
   guard (tool-execute failures) and watchdog (silent stalls), so no
   double-wrapping:
   - **StreamErrorRetryProcessor** — retries transient mid-stream errors
     (OpenAI Responses `error`/`response.failed`, provider `isRetryable`, and an
     `isEconnResetStreamError` matcher with capped exponential backoff). Since
     core 1.51 the config additionally sets `retryUnknownErrors: true` — an
     UNKNOWN stream error (matched by nothing) is retried under the same
     bounded budget/backoff, while known-terminal authorization failures
     (401/403 or `invalid_api_key`-class codes, walked through the cause
     chain) surface immediately with NO retry (a bad key must fail loudly) —
     and `maxRetryAfterMs` pinned to the SAME 30s ceiling as the backoff cap,
     clamping provider `Retry-After` headers so neither our wait nor the
     provider's demand can stall a retry past it; the wait is abort-aware.
     **ERROR-PROCESSOR ORDER IS LOAD-BEARING** (do not relitigate): Mastra's
     ProcessorRunner returns at the FIRST processor that requests a retry, so
     the stack is [PrefillErrorHandler, ProviderHistoryCompat,
     StreamErrorRetryProcessor] — the FIXUP processors must see the error (at
     `retryCount === 0`) before the unknown-error retry, or a deterministic
     prefill/history-compat rejection is blindly re-sent unchanged until the
     budget burns. Pinned by the prompt-sensitive prefill test (the scripted
     model keeps rejecting while the prompt still ends with an assistant
     message — a blind retry cannot fake recovery). Deliberate trade-off:
     deterministic non-auth errors (e.g. 400 context-length) eat the bounded
     ~3s unknown-retry budget before surfacing.
   - **PrefillErrorHandler** — recovers reloaded-thread assistant-prefill
     rejections (Anthropic / Qwen `enable_thinking`).
   - **ProviderHistoryCompat** — cross-provider `mastra_messages` reuse.
   Placement (verified against the compiled loop, do NOT relitigate): the two
   `processAPIError`-only processors + ProviderHistoryCompat's REACTIVE rules go
   on the Agent-config `errorProcessors` seam (never clobbered by the per-call
   TokenLimiter). ProviderHistoryCompat's PREEMPTIVE `processLLMRequest` rules
   (strip foreign reasoning — the ONLY place that incompatibility is handled)
   fire ONLY from `inputProcessors`, so a SECOND ProviderHistoryCompat instance
   is composed into the per-call `inputProcessors` array ALONGSIDE the
   TokenLimiter in `buildToolLoopOptions` (composing, not clobbering — their
   hooks are disjoint stages). **`maxProcessorRetries` MUST stay pinned**
   (`ASSISTANT_MAX_PROCESSOR_RETRIES = 3`): any `errorProcessors` flips Mastra's
   implicit default to 10. The whole layer is EXCLUDED for the built-in local
   provider (the hidden llm-host owns its own engine-fault recovery; no
   hosted-provider wire quirks apply).

Every provider/model error that reaches the stream mapper is classified at that
single choke point; no provider-specific fetch wrapper or retry-attempt
instrumentation participates. The terminal `run.failed` event carries one
namespaced `metadata.runError` object with exactly `code`, optional `message`,
`causeChain`, `httpStatus`, `providerRequestId`, and `responseHeaders`. The
extractor walks bounded `Error.cause` / AI SDK `APICallError` shapes and, when
the code is not on the explicit stable allowlist, classifies by provider
evidence: `mastra_agent_stream_provider_error` when the walk found an
`httpStatus`, `providerRequestId`, allowlisted `responseHeaders`, or an AI SDK
api-call error marker (`AI_APICallError` / `AI_RetryError` name, or
`url` + `requestBodyValues` — these exist only for calls that crossed to a
provider), and `mastra_agent_stream_local_error` when it found none — a local
runtime fault (e.g. a TypeError inside the stream chain) must never wear the
provider label (the 2026-08-03 grepSearch-projection incident), and a real
provider failure that arrived without response metadata must never wear the
local one. The extractor emits at most
four bounded cause strings. Every truncated string ends with `… [truncated]`;
truncation is never silent.

The adjacent diagnostic breadcrumb uses the provider code plus validated HTTP
status in its diagnostic code so unrelated provider failures do not collapse
into one fingerprint. Content-policy tripwires terminate visibly through their
own `mastra_agent_stream_tripwire` diagnostic and never carry the provider
`metadata.runError` envelope. Mastra 1.51's canonical tripwire shape is
`{type:'tripwire', payload:{reason,retry?,metadata?,processorId?}}`; the mapper
must read that payload rather than the obsolete top-level fixture shape. The
bounded reason becomes visible assistant text plus durable `run.failed.detail`.
The sanitized processor fields travel under `metadata.tripwire` and the same
object is logged with durable run/thread/resource/root correlation. Arbitrary
metadata is JSON-validated, passed through the shared run-event denial-list,
then reduced by value shape before either persistence or logging: only
identifier-shaped values for the explicit safe diagnostic keys plus finite
numbers, booleans, null, and Mastra's literal `[REDACTED_MATCH]` marker retain
their value. Other strings become character-count summaries. Arrays and objects
are capped at 32 items/keys and use the reserved `__brainstrikeSummary`
envelope for unambiguous type/count/omission bookkeeping; keys are capped at
128 characters. Processor ids are capped at 256 characters. The visible,
durable, and logged tripwire reason is capped at the shared 600-character
provider-error limit because policy-triggering content must not gain a larger
server-log exposure than it has in the thread.
Malformed fields are enumerated in
`metadata.tripwire.malformedFields`, and a missing/malformed reason produces an
explicit visible compatibility error rather than the generic word "tripwire".
The pre-1.51 top-level or payload `tripwireReason` reader remains an explicit
compatibility input tagged `source:'legacy-tripwire-reason'`, including hybrid
parts that also carry current sibling fields but omit `payload.reason`; remove
it only alongside a Mastra compatibility-baseline change and its paired
regression test.

Response headers are a literal, case-normalized allowlist limited to
rate-limit, `Retry-After`, and provider request-id variants. Request/response
bodies, arbitrary `data` or provider metadata, request headers, URLs,
credentials, and retry-attempt payloads never enter the event. OpenRouter's
documented canonical token-limit vocabulary is still recognized across both
mid-stream raw errors and the AI SDK pre-stream `APICallError.data` envelope,
and remains visible in the bounded user-facing failure. Other providers use the
same generic extractor and stable fallback code. `readProviderRunError` /
`isProviderRunError`, exported by `@brainstrike/agent`, are the strict consumer
boundary; downstream integrations must not hand-parse arbitrary event metadata.

The provider-error termination log is also the durable diagnostic correlation
choke point. It copies `runId`, `threadId`, and `resourceId` from
`runtimeData.memory` plus `rootId` from the server-validated
`runtimeData.boundWorkspaceRootId` into the structured logger context argument.
The run id remains the renderer-minted durable run created before dispatch;
there is no second producer. These values MUST NOT use logger bindings, ambient
async context, `mainRootId`, or another inferred-root fallback: the diagnostic
converter promotes only explicit context keys, and an absent identity stays
absent rather than being guessed.

Hosted agent loops default to 100 model steps when the user has not configured
an explicit lower limit. The Output & Limits UI must describe that finite
default truthfully; an unset override is not an unbounded or "Open" run.
Output-limit finishes are terminal failures, not successful completions:
`finishReason: length` emits `run.failed`, an error finish, and a failed durable
run outcome. The desktop data-stream session receives the selected provider,
model, and `requestedReasoningEffort` as narrow output-limit context; that field
is absent for Auto even when provider options contain a resolved wire effort.
When Kimi K3 reaches the limit at explicit `high` or `max`, the terminal copy
tells the user to retry at Low or Auto; it never changes effort, retries, or
enlarges the output window automatically. Other models and efforts retain the
generic output-limit failure. Hosted Web accepts but ignores the shared wire
field because its trust boundary owns model/generation policy server-side and
currently exposes no explicit client reasoning-effort path.

**EVERY error finish is a failed durable outcome, not just `length`.** All three
parts of that sentence apply to `finishReason: 'error'` too — the finish emitted
by `makeProviderErrorTermination`, `makeStreamStalledTermination`,
`makeToolCallInputTimeoutTermination`, and the empty-model-response termination
(all five abnormal-ending policies live in
`packages/agent/src/mastra/stream-termination.ts` since BST-986; the watchdog
MECHANISM stays in `../stream/with-*-timeout.ts`). This was NOT true until 2026-07-25:
`getAbnormalFinishMessage` returns `undefined` for `'error'` (deliberately — the
termination helpers already emit the human detail as a visible text-delta, so a
message here would double-report it), and `terminalFailureText` was only ever
assigned from that message, so an error finish fell through to
`{status: 'completed', error: null}`. A provider failure therefore emitted a
`run.failed` run event while `thread_runs` recorded the run as SUCCEEDED — the
ledger contradicted its own events, and the debug bundle's Failure summary
(which reads `thread_runs`) reported success for exactly the runs it exists to
diagnose.

`handleFinish` now sets `terminalFailureText` for an `'error'` finish without
emitting a visible message, taking the text from the preceding `run.failed`
event's label and falling back to `ERROR_FINISH_FALLBACK_TEXT`. Two paired tests
in `data-stream-session.spec.ts` keep this honest: one pins the run-event-derived
text, one pins the bare-finish fallback — either alone would pass without the
other's mechanism working. Do not "simplify" this by making
`getAbnormalFinishMessage` return a string for `'error'`; that reintroduces the
duplicate visible message. `tool-calls` and `stop` correctly remain
`completed` — they are intermediate/normal finishes, not terminals.

The durable text comes from the `run.failed` event's **`detail`**, not its
`label`: all three terminations share the generic label "Assistant run failed",
so persisting the label alone yields a correct status with no forensic value.
`makeRunFailedChunk` exists to carry that detail. It is a separate helper rather
than another optional parameter on `makeRunEventChunk` because `detail` and
`timestamp` are both `string`, so a positional slip between them would
type-check cleanly while writing a timestamp into the detail field.

**A provider-evidenced HTTP 401 is a REJECTED CREDENTIAL, and the visible
detail says so — with the remedy for THAT provider's auth type (BST-1384).**
`resolveProviderError` (`mastra-chunk-decoding.ts`) rewrites the human detail
for a run error whose `httpStatus` is 401 into "<remedy> Provider response:
<body>", where the remedy is keyed by the registry `authType` of the run's
provider (subject = registry `displayName`):
`api_key` → "rejected the API key … Update the key in Settings → Providers, or
verify it in the provider dashboard"; `oauth_subscription` → "rejected the
sign-in session … Sign in again in Settings → Providers" (its stored key is the
`oauth-subscription-no-api-key` placeholder — an api-key remedy would be a
dead end); `aws` → "rejected the AWS credentials … Update the Bedrock credential
… or refresh the AWS profile session"; `none` → "rejected the request as
unauthorized … Check the runtime’s API token under Settings → Local Runtimes"
(the optional local-runtime bearer is `providerOptions.apiToken`, not a Settings
key); unknown provider → a neutral "rejected the credential" sentence. Adding a
registry `authType` is a compile error here until it picks a remedy. Guidance
comes FIRST so the visible clamp can only ever shorten the provider's own text
(pinned by the clamp spec). 401 is the ONE wrong-credential status, mirroring
the Settings "Test connection" probe's settled classifier
(`provider-verification.ts`: 403 = authenticated-but-limited, 429 = rate-limited
VALID credential) — a run must never blame the credential for a status the
probe reports as verified. The `runError` envelope (code, `httpStatus`, the
`mastra_agent_stream_provider_error:401` log fingerprint, debug-bundle fields)
is byte-identical to before; only the detail changes. DELIBERATE asymmetry with
the probe, do not "fix" either side to match the other: the probe composes its
detail from the status alone (bodies are never echoed there), while this path
appends the provider body — it is the user's only provider-side evidence, the
pre-change visible detail WAS the raw body, and `runError.message` persists it
regardless, so nothing new is exposed (some providers do echo a partially
masked key in a 401 body, e.g. OpenAI's `Incorrect API key provided: sk-…XYZ`).
Motivating field failure (2026-08-21): OpenRouter's 401 body is literally "User
not found." for ANY unrecognized key, so a revoked stored key surfaced as an
opaque app failure and read as a regression for a day. Pinned by the
`rejected credential (HTTP 401)` block in `mastra-chunk-decoding.spec.ts`.

**Finish-reason absence is distinct from a raw unsupported value (BST-868).**
`readFinishReason` and `resolveFinishReason` preserve a missing, empty, or
non-string Mastra field as Brainstrike's internal `'absent'` sentinel. The AI
SDK's literal `'unknown'` also remains completed because that upstream value
already combines "provider omitted the field" with provider values the SDK does
not recognize; Brainstrike cannot safely reconstruct that lost distinction.
Only a non-empty raw value outside the SDK/Brainstrike union becomes the
internal `'unrecognized'` sentinel, emits `run.failed`, surfaces the explicit
"unrecognized finish reason" message, and persists `thread_runs` as failed.
Before data-stream serialization, internal `absent` becomes assistant-stream
0.3.37's completed wire value (behavior verified at 0.3.25, unchanged by the
0.3.34 and 0.3.37 lockstep bumps — `unknown` is still in the completed-status
union at 0.3.37) `unknown`; internal `unrecognized` becomes the
terminal wire value `error`. Intermediate steps start as `absent`, never as the
SDK-owned `unknown`. Keep these internal sentinels out of the legacy data-stream
protocol and never infer provider failure from the AI SDK `unknown` value.
