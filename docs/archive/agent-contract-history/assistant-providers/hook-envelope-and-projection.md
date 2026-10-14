# Hook envelope and projection contract — evidence

Supports `docs/agents/assistant-providers.md` § "Context-window-scaled default budgets". The hook result envelope, the Mastra projector signature, token limiting, and measurement.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 4371-4460); append rather than
rewrite.

---

For successful
hooked results, every original result shape and its control metadata travel in
the explicitly discriminated internal `HOOK_RESULT_ENVELOPE_FIELD` protocol.
The official Mastra display/transcript transforms unwrap that protocol for
application and persistence consumers; Brainstrike's PGlite store enforces the
transcript projection at its write boundary because Mastra 1.51 otherwise
stores the carrier alongside its transform metadata. The envelope is also
removed and the exact domain result restored before either a custom or default
projector runs. The central composer then appends PostToolUse context without
reordering authored content parts, truncating only that context when needed to
keep the final generic non-media serialized envelope at or below 8000
characters. A nullish synchronous or asynchronous custom projection
falls through to the bounded deterministic default over the clean domain
result, while malformed non-callable projections throw. Serialized-character
checks include JSON escaping; inline media bodies are excluded while their
metadata is counted. MCP image/audio results use Mastra `content` output so
base64 media remains model-native while companion text is bounded.
When a valid MCP result includes both `structuredContent` and image/audio
`content`, the transport-owned MCP runtime preserves the canonical result envelope
through persistence bounding instead of collapsing to the structured object.
The structured JSON joins the bounded model-facing companion text while the
media remains model-native; both the inline-media and non-media persistence
ceilings still fail visibly before transport. The discovered output schema
remains exposed for documentation, while the official MCP SDK owns
structured-output validation and Mastra does not incorrectly re-validate the
complete `CallToolResult` envelope against the inner schema.
Brainstrike's projection contract is Mastra 1.51's documented CoreTool
`toModelOutput(output)` callback: `output` is the raw execute result. Do not
reinterpret a public `{toolCallId,input,output}` object by shape; those keys are
valid domain data, and Mastra owns AI SDK adapter normalization at its known
boundary. Any future standalone AI SDK v6 adapter must be a separately named
boundary with an explicit input type, not an ambiguous branch inside the
one-argument Mastra projector. The real Mastra loop regression pins this with
an exact three-key domain result. `skill` is the explicit text exception: its
instruction body cannot be paged, so the complete 6000-token activation budget
remains available and a separate bounded 2000-character PostToolUse allowance
plus structural reserve expands only its final model-facing envelope.

Mastra 1.51's stock `TokenLimiter` counts raw database-shaped
`toolInvocation.result` before provider conversion. Brainstrike therefore
installs `ProjectionAwareTokenLimiter`: it temporarily substitutes the stored
`providerMetadata.mastra.modelOutput` (with inline media replaced by counting
markers), delegates to Mastra's limiter, and restores the exact raw result in a
`finally`. Keep its canonical processor id `token-limiter`.

Before compatibility normalization and token limiting, hosted runs apply the
projection-safe stale-history filter documented in `assistant-runtime.md`.
Brainstrike owns the per-call eligibility and one-tool-step window because
Mastra's stock processor filters by tool name and performs its transform from a
message-processing hook whose result is applied to the live `MessageList`.
Eligibility is recorded during `processInputStep`; replacement happens only in
Mastra's transient `processLLMRequest` hook. Persisted raw evidence and artifact
continuation data therefore remain authoritative. Stateful writes remain
verbatim regardless of age, while the newest eligible read/search/retrieval
step protects the only current verification result without retaining an older
redundant read. Protected state tools do not consume that recent-read window.

Runtime token measurement is observational and MUST NOT replace those safety
limits. `provider-registry.ts` resolves one explicit capability from the exact
provider/model tuple: `exact-selected-model`, `declared-compatible-reference`,
or `deterministic-serialized-character-backstop`. The current direct OpenAI
GPT-5.x registry entries deliberately declare local `o200k_base` as a compatible
reference, not an exact selected-model tokenizer; `openai/gpt-4o` is the
explicit verified exact mapping. Anthropic, Google, OpenRouter aliases, local
runtimes, and unknown tuples keep the four-serialized-characters-per-token
backstop. Never infer a tokenizer from a model-name substring.

`@brainstrike/tokenization` is the single implementation owner for the shared
heuristic and cost modules plus the strict o200k counter. The root is the eager,
asset-free surface; the only public subpaths are the strict-counter and
worker-lite modules with real consumers. `text-splitter`, `utils`, and worker
packages must not carry re-export facades or local copies. The worker bundles
still inline that one source independently at their real bundle boundaries, so
neither worker imports the other's runtime graph.

`RunTokenDiagnostics` initializes the declared local tokenizer once while the
server-side Mastra runtime is built, normalizes the FINAL tool map through
Mastra's Standard Schema conversion, and observes only already-bounded
`toModelOutput` projections. Inline media bodies become deterministic markers
before measurement. One `mastra_agent_token_measurement` structured log joins
the mode, tokenizer (when declared), tool-definition count/tokens, projected
result count/tokens, independent backstop totals, and actual provider/Mastra
prompt usage when reported. It contains counts and bounded failure metadata
only—never raw prompts, tool schemas, results, credentials, or user content.
Counter initialization/execution failure retains the declared mode, omits the
unavailable tokenizer counts, keeps the deterministic backstop totals, and logs
at warning level; it never silently changes measurement semantics or disables
the independent serialized-character safety envelope. Paired proofs:
`provider-registry-token-measurement.test.ts`, `token-measurement.spec.ts`,
`tool-model-output.spec.ts`, and `mastra-streaming.spec.ts`.
