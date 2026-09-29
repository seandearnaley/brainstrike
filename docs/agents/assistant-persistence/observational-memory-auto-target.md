# Observational memory and the auto observer target — evidence

Supports `docs/agents/assistant-persistence.md` §
"ASSISTANT THREAD PERSISTENCE & RELOAD HYDRATION". Read this before proposing to change the auto-observer candidate list, the privacy ruling, or the embedder specification facade.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Built-in LOCAL provider turns persist on DESKTOP: local chat routes through
the assistant server's Mastra loop (see LOCAL LLM ARCHITECTURE), so memory,
run events, and reload hydration behave exactly like hosted providers.
Observational memory is ON by default (BST-940) at Mastra's documented
thresholds (observation.messageTokens 30K / reflection.observationTokens 40K)
with the `'auto'` observer target (`OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET`).
`resolveEffectiveObservationalMemorySettings` (app-shell wrapper-runtime, memo'd
once in the wrapper) resolves `'auto'` into CONCRETE settings consumed by
request data, memory validation, and the OM meter alike, under the PRIVACY
RULING (PR #2039 review — do not relitigate): the auto observer is only ever a
Mastra-tested fast model FROM THE SELECTED CHAT PROVIDER — the party already
receiving the conversation — never a different keyed provider (anthropic →
claude-haiku-4-5, google → gemini-2.5-flash, openai → gpt-5.4-mini; openrouter
carries ORDERED fallbacks — gemini-2.5-flash → gemini-3.5-flash-lite →
deepseek-v4-flash — because its catalog seeds the preferred Gemini targets
disabled; via the contract's pure `listAutoObservationalMemoryCandidates`,
first catalog-eligible candidate wins). A local/keyless/web chat, or a
candidate set the user fully disabled in the model catalog (the wrapper passes
an `isTargetEligible` predicate over the loaded registry, same gate as the
settings dropdown), flips `enabled → false` with an explicit unresolved reason
surfaced as the popover's 'awaiting-observer' OM state and the Settings auto
note. An unresolved auto must NEVER disable thread memory, and `'auto'` must
never reach the provider/model validator (the validator also resolves
defensively, and the desktop server resolves the sentinel again at request
intake — `resolveServerAutoObservationalMemory` — so a raw client shipping
'auto' can neither 502 a local stream nor conjure a cross-provider observer).
The built-in local Gemma is deliberately NOT an auto candidate — its 8K
runtime budget cannot observe the 30K message threshold. An EXPLICIT
(non-auto) target keeps the original loud validation: enabling a hosted target
without that provider's key fails visibly.
Construction seams that receive no settings (memory factory default arg,
desktop-server absent-field fallbacks) use
`CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS` (observation OFF) — an
absent settings object must never manufacture an enabled observer.
Hosted EMBEDDERS for Mastra memory (`createEmbeddingProvider`) are wrapped in
`asSpecV3EmbeddingModel`: current @ai-sdk embedding models declare
specification 'v4', and @mastra/memory's embed dispatch switches on that
literal ('v3'/'v2' → modern pipelines, anything else → a legacy v1-only
pipeline that throws "AI SDK 4 only supports … v1"). A raw 'v4' embedder
therefore failed EVERY observational-memory vector-retrieval cycle in the
field (BST-940 debug bundle 2026-07-27) — the facade is load-bearing, not a
type cast. OM cycle failures streamed as `data-om-*-failed` chunks surface as
durable `memory.observation.failed` run events (see assistant-runtime.md).
Pinned by the VECTOR-retrieval and observer wire cases in
`mastra-memory-persistence.integration.spec.ts`.
Known gap: WEB local turns still use the in-renderer LocalRuntimeChat (no
history adapter) and remain session-only.

When changing message persistence or hydration, update this section and the
paired tests in packages/agent and packages/app-shell.

MCP Task status is deliberately outside assistant message persistence. A task
handle is not a synchronous tool result, and the renderer must not serialize
its live status, input requests, result metadata, or control identity into a
message part to make restart recovery appear to work. Migration 115 and the
exact principal/server/resource/authority-epoch scope remain authoritative.
After a restart, an opt-in host adapter must rebuild the bounded presentation
from that durable row and mark it `restart_required`; `McpTaskStatusCard` owns only the
controlled display and action focus. This layer adds no renderer store and no
fallback to stale message history.

