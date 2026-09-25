# Assistant Providers, MCP Transports, Native Tools

> Read before changing provider config, credential handling, MCP transport
> selection, or assistant native tools/registries. Rules here are true now; the
> record behind each is in `assistant-providers/<topic>.md`.

## Production web runtime capability

- The production web bootstrap configures local-runtime browser access before
  provider discovery. Its CSP permits no arbitrary local/LAN endpoint, so the
  discovery service returns the visible `blocked_web` state before fetching,
  including when a caller overrides its surface to desktop. Provider discovery
  and model catalogs use that same service.
- Treat that state as an immutable host capability, not a user preference:
  factory reset does not clear it. Desktop's native runtime bridge and
  development web direct probing keep their existing behavior.
- Let the host's capability decision stand. Do not widen the CSP, and do not
  re-issue forbidden probes as a substitute for it.

Guard: the paired discovery and real-catalog tests (zero browser requests, an
unchanged independently configured native probe) plus the compiled production
CSP test over startup, PGlite and embedding workers.

## AI ASSISTANT INTEGRATION

Supported providers: hosted OpenAI, Anthropic, Google, OpenRouter, Amazon
Bedrock and OpenAI Codex, plus keyless Ollama and LM Studio local servers and the
built-in browser-local model. Config lives in
`packages/agent/src/providers/{registry,key-resolver,provider-factory}.ts`; user
setup in `docs/local-model-servers.md`. Preferences persist the last selected
model as the next thread's default plus a capped `recentModels` list
(`packages/app-state/src/stores/assistant-preferences-store.ts`); the thread
store persists each thread's own model and provider settings.

**Local runtimes.**

- Route Ollama and LM Studio chat through Mastra's first-class
  OpenAI-compatible model config (`{ id, url, apiKey }`), not `@ai-sdk/openai`.
  Normalize the origin to a `/v1` base URL and pass an explicit dummy key when
  local auth is disabled, so `OPENAI_API_KEY` is never sent to a LAN server.
- `providerOptions.ollama` / `.lmstudio` are transport configuration, not
  generation options. Strip both at every Mastra stream/resume boundary so
  `baseUrl` and `apiToken` cannot serialize into a request body.
- Local-runtime HTTP goes through `fetchJsonWithTimeout`. Read `fetchImpl` into a
  local before calling it and bind the ambient default at capture
  (`globalThis.fetch?.bind(globalThis)`); regression cover must be
  receiver-aware, because a plain mock is indifferent to its receiver.
- Resolve every `/api/tags` candidate through authoritative `POST /api/show`
  capabilities before exposing it; a failed lookup fails the catalog visibly.
  Only `completion` models enter the picker. The `/v1/models` fallback keeps
  capability source `inferred` and is never followed by a native `/api/show`. A
  forced refresh forces every native lookup.
- `capabilities.vision` is tri-state (`supported | unsupported | unknown`);
  never coerce unknown to unsupported.

**Built-in local provider.**

- Desktop and web target `onnx-community/gemma-4-E2B-it-ONNX` only. Without
  WebGPU the provider is unavailable — there is no WASM fallback.
- Desktop runs local chat through the assistant server's real Mastra loop and
  proxies inference to the hidden llm-host; the local model is also selectable
  as observational-memory model and local embedders as the recall embedder, all
  keyless. See LOCAL LLM ARCHITECTURE.
- Local tool-call arguments must parse as a root JSON object before a provider
  tool-call part is emitted. A malformed call terminates generation with
  `local_tool_call_arguments_invalid` and bounded diagnostics — never repaired
  from raw text, never coerced to `{}`.
- Only the broad `@brainstrike/agent` entrypoint registers the browser-only
  local language-model factory; server-safe subpaths, especially
  `/hosted-web`, must never import or register that Transformers graph, and
  local-provider behavior must not depend on import order.

**Credentials.**

- Settings manages every credential through the Credential Inventory
  (`packages/settings-ui/src/settings/secrets/credential-inventory/`): one
  always-visible row per slot, slots a superset of registry providers plus the
  Tavily key, `keyNotes`/`keyFormatHint`/`docsUrl` rendered generically, and env
  rows read-only so mutation buttons never render inert. The `aws` editor
  requires an `isValidAwsRegion`-gated region in BOTH modes, keeps the profile
  input optional, and writes only through the typed `saveCredential` bridge; a
  profile-chain save demands no secret and therefore carries no `…last4`
  fingerprint.
- Keychain values are typed credentials: `JSON.stringify(credential)` of the
  union in `packages/assistant-contract/src/provider-credential.ts`, written
  through one path so even `saveKey` stores the envelope.
- A decrypted value that never claims a `type` tag IS `{ type: 'api_key', key }`
  — a defined mapping over every pre-existing key, kept forever. A value that
  carries a `type` tag but fails validation throws `SecretReadError`
  (`malformed_credential`), never coerced, with a static message.
- `getKey` returns `.key` only for `api_key`; any other type throws
  `credential_type_unsupported`. Availability inspection reads typed
  credentials, so a valid credential of any type marks the provider configured
  and only malformed entries surface as `readFailures`.
- `secrets:list` projects the save-time `{last4, savedAt}` fingerprint and
  nothing else; a partial pair is withheld. `parseProviderKeySources` is the ONE
  wire-shape parser for both strict renderer consumers.
- Secrets IPC never throws domain errors across invoke: writes resolve
  `true | { ok: false, error }`, reads resolve `{ ok: true, credential | null }`
  or the serialized failure, and `setCredential`'s guard is the single write
  validator.
- The secrets bridge is a visible-UI capability: every secrets IPC operation
  declares and enforces the `visible-ui` sender role before arguments are parsed
  or keychain code runs, and hidden preloads carry neither it nor assistant
  URL/token credentials. Possession of a preload channel is never authority.

**Environment credentials.**

- Desktop loads provider credentials from environment files before any
  provider/key inspection; `src/main-bootstrap.ts` completes that load before
  importing the `src/main.ts` runtime graph. Unpackaged launches read
  `.env.local` then `.env`; packaged launches may read only `<userData>/.env`.
  The inherited process environment stays authoritative even when empty.
- Validation is ALL-OR-NOTHING: one malformed line applies nothing and surfaces
  through both the status probe and Settings. Files may set only the names in
  `apps/desktop/.env.example`; assignment-boundary whitespace is rejected rather
  than trimmed; missing files are valid. `NODE_ENV=test`,
  `ELECTRON_IS_E2E_TEST=true` and `--test-mode` disable file loading entirely.
- Every keyed provider resolves exactly two names,
  `BRAINSTRIKE_<PROVIDER>_API_KEY` then the vendor-standard name; the chain is
  `BRAINSTRIKE_*` > vendor > stored keychain secret, and `provider-catalog.json`
  (`envKeys` + `deprecatedEnvKeys`) is the only source for both lists.
- Deprecated names obey three invariants: they stay in the desktop `.env`
  allow-list forever (an unrecognized name rejects the whole file), stay in the
  child-env scrubber forever, and are absent from every resolution list. When
  set they surface as `deprecatedEnvVars` on `/assistant/status` — names only.
- A stored-key `SecretReadError` propagates as typed `api_key_unreadable`; never
  coerce it into `missing_api_key`. Embeddings may continue on a valid
  environment credential after a stored read failure but must rethrow when none
  exists. Saving, replacing or deleting a secret re-probes assistant status.

**Provider-backed memory.**

- Observational memory and semantic recall distinguish `disabled`, `resolved`
  (built-in local only) and `needs_async_resolution`; the last performs the
  env/keychain lookup before constructing Mastra memory. Every hosted target
  resolves through the same chain the request used — RuntimeData carries no
  bearer key. A completed lookup with no key returns HTTP 400
  `memory_credential_missing` with the bounded provider and feature; a
  `SecretReadError` stays `api_key_unreadable`.
- A hosted observer or embedder without a configured key is excluded from
  selectable memory models, prevents its toggle and blocks the next run.
  Renderer gates prefer the matching validated `providerErrors` repair message
  over generic missing-key guidance. A serialized model target is never evidence
  a credential exists, and an omitted `providerKeySources` means "provenance not
  exposed", not "validated empty".
- Built-in local observational memory requires the desktop assistant-server
  bridge; hosted chat requires a positively available Mastra memory backend. The
  composer gate and request-data builder consume ONE shared capability
  predicate — do not duplicate the rule.

**Hosted Web.**

- Hosted Web reads server-only OpenAI, Anthropic, Google and OpenRouter
  environment keys using each registry entry's canonical precedence;
  whitespace-only values are unconfigured. Status advertises configured ids and
  safe env-key sources, never values. A request selects only one of that set;
  the server injects its key and ignores client model/key/base-URL attempts.
  Never expose a key through a `VITE_` variable.
- The Vite dev/preview middleware enforces a LOCAL request boundary before
  status, body parsing or stream dispatch: loopback peer, exact `localhost` or
  loopback `Host`, same-origin `Origin`/Fetch Metadata, and JSON content type on
  POSTs. Do not weaken it because Vite also has listener controls.
- Deployable Vercel entrypoints enable the key only when `VERCEL_ENV=preview`;
  every other value fails closed as `production_auth_required`. Production
  enablement requires application authentication plus distributed quota/cost
  controls.
- Both transports run one converged decision core (`runWebAssistantPost`) whose
  `filterPayload` hook ORDERING is a contract: after payload text parsing,
  before tool-continuation extraction and native-tool-id validation. A refactor
  that moves or bypasses it moves web's trust boundary — update the tests and
  this section together.
- A request naming no `data.provider` is rejected `missing_provider` / HTTP 400
  exactly like desktop, and the 503 server-config gate precedes request
  validation. Do not reintroduce a default-provider fallback in either transport.
- Strictly validate every request value and reject server-only,
  capability-inapplicable or unknown fields (`apiKey`, `mcpConfig`,
  `mastraTools`, `permissionPolicy`, `permissionPolicyRequest`) as
  `invalid_runtime_data` / HTTP 400. TypeScript types are not a request trust
  boundary.
- Hosted Web's serialized body capability is 4 MiB, below Vercel's
  non-configurable 4.5 MB ingress ceiling; desktop keeps 16 MiB.
  `BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES` may lower the server cap,
  never raise it; overflow fails `request_body_too_large` / HTTP 413 while the
  stream drains.
- The canonical envelope has exactly four top-level fields: required `messages`
  plus optional `data`, `runConfig`, `unstable_assistantMessageId`. Anything
  else fails `invalid_request_payload` / HTTP 400. Only the shared
  approval/suspend readers consume `runConfig`; forward no other subtree.
- Hosted Web has no durable workflow or stream-replay store, so approval and
  suspend-resume actions return typed HTTP 409 and every non-empty
  `Last-Event-ID` returns `stream_resume_unavailable`. These requests still
  consume the bounded body first.

**OpenRouter.**

- Configure OpenRouter through Mastra's `openrouter/<provider>/<model>`
  model-router ids, never a generic `createOpenAI({ baseURL })`. The factory
  materializes the `ModelRouterLanguageModel` and injects the strict-content
  gateway (`packages/agent/src/providers/openrouter-strict-content.ts`), which
  claims only strict-content families (`qwen/*`) and coerces `null` → `""`;
  every other model resolves through Mastra's own gateway untouched. Retire the
  gateway when the upstream converter stops emitting `null`.
- **A missing cost records UNKNOWN; only a malformed one fails — do not
  relitigate.** An incomplete picture records the turn cost as unknown (omitted,
  stored null) with a visible `provider_billed_cost_unreported` warning. Never
  zero, and never a partial sum presented as the total; a genuine `cost: 0` is a
  measured zero. `readOpenRouterBilledCost` returns
  `absent | malformed | reported`, and malformed logs
  `provider_billed_cost_malformed` at ERROR and treats the step as unpriced.
- Use the native `providerOptions.openrouter` namespace with
  `provider.require_parameters: true`, so OpenRouter cannot silently route to an
  upstream that ignores requested parameters. The explicit Off choice maps to
  `reasoning.enabled: false`; `none` is never sent as a guessed effort. Never
  reuse the OpenAI camel-case shape.
- `Auto` is a zero-configuration coding profile, not a provider-wide 4,096-token
  cap. With reasoning off the limit is `min(model max completion, 32,000)`, else
  32,000. When reasoning is enabled by default the Auto effort is DECLARED
  (catalog `reasoning.autoEffort`, else the vendor's `defaultEffort`); with
  neither declared, send no effort.
- The output window is not independent of effort: a model whose vendor documents
  a completion window sized for always-on thinking records
  `reasoning.vendorDefaultOutputTokens`, and `resolveOpenRouterOutputWindow`
  sends it whenever the request actually reasons, capped by a declared maximum.
  The window is a truncation cap, not a spend target, recorded from vendor docs
  only.
- Send the Auto output profile explicitly — Mastra's provider otherwise expands
  an omitted limit to the model's full ceiling, which can make OpenRouter reject
  a tiny prompt during credit preflight. The input-token budget reserves the
  same resolved value, never the full ceiling.
- Static prices are estimates; exact provider-reported cost is authoritative.
  Never log or persist reasoning content.
- Enablement: `OPENROUTER_RECOMMENDED_CODING_MODEL_IDS` is this provider's
  `seed` entry, applied once — key replacement, reload and catalog refresh
  never reapply it. See § "`is_enabled` is not evidence of user intent".
- The model menu and the per-thread provider-options builder must use the same
  resolved live metadata snapshot.

**Reasoning depth and visibility.**

- Reasoning has two INDEPENDENT dimensions that must not be re-conflated. DEPTH
  is a budget concern (`reasoningEffort`, `anthropicEffort`,
  `googleThinkingLevel`, the OpenRouter auto profile). VISIBILITY is the single
  cross-provider `reasoningVisible` setting resolved by
  `packages/assistant-contract/src/reasoning-visibility.ts` and projected onto
  each provider's own wire field.
- Three hard rules: visibility only MODIFIES a reasoning request already being
  made (always-on `mandatory` Anthropic rows send `thinking` at Auto solely to
  carry `display`, because those models always reason, so that request is
  always being made); output is never suppressed for reasoning that is switched
  off; and the OpenRouter VISIBLE path adds no field at all, because
  `require_parameters` would shrink the eligible upstream pool. Only the
  opt-out adds `exclude: true`, and do not reintroduce a default
  `openrouter.reasoning.summary`.
- Provider-specific keys are valid escape hatches and win when set, and each
  control must render the RESOLVED value, not the raw key.
- The Anthropic Thinking toggle is authoritative for "is Claude thinking": switching it off clears the effort as well as the budget; always-on rows (`mandatory`, e.g. Fable) expose no toggle, and a cleared toggleable ladder row serialises explicit `disabled` rather than an omit that would leave default-on rows thinking. Always-on rows (`mandatory`: Opus 5.5, Fable 5/5.1) send `thinking: {type: 'adaptive', display}` at every effort, Auto included (Auto sends no effort). Why: the vendor default `display` is `omitted`, so an omitted `thinking` hides reasoning and Opus 5.5's between-tool-call progress text. Visibility uses only the GA `summarized`/`omitted`. Evidence: `assistant-providers/anthropic-thinking-mirrors.md`.
- The offered Anthropic ladder is declared per model in
  `LlmModelDefinition.anthropicReasoning`, recorded from vendor documentation
  and never derived from union membership. An effort outside a model's ladder —
  including no ladder and no registry row — is treated as ABSENT: no effort and
  no derived adaptive thinking, never a neighbouring effort. An explicit legacy
  budget survives independently.
- Declare each effort vocabulary ONCE in `@brainstrike/types`
  (`OPENAI_REASONING_EFFORT_VALUES`, `OpenAiReasoningSummary`,
  `GoogleThinkingLevel`), re-exported by `assistant-contract/runtime-data.ts` and
  `agent/types.ts`. A values const is union MEMBERSHIP, never an offered list —
  what a model offers stays in `resolveReasoningControlsAvailability`.
- The provider-options INTERFACES are deliberately not shared between
  `assistant-contract` (extending `RuntimeJsonObject`) and `agent/types.ts`
  (extending `@ai-sdk/provider`'s `JSONObject`). Unify them only by resolving
  that base-type split first; add a new one to both files in one change.
- OpenRouter reasoning controls are capability-aware when the Models API
  publishes a `reasoning` object; absence is never guessed as support. An
  UNDECLARED model exposes no controls and its capability badge resolves to a
  visible `unknown`. On an explicit model switch, clear an incompatible
  provider-wide effort rather than mapping it to a nearest level.
- Effort/level selection and the primary Thinking toggle live in the
  always-visible `ComposerEffortControl` chip whose trigger doubles as the
  readout; the Controls panel's "Output & Limits" keeps runtime limits, max
  output, the shared reasoning-output summary, the Anthropic numeric budget and
  the Google include-thoughts toggle. Moved controls emit byte-identical
  settings updates.

**Provider-boundary history seams.**

- OpenAI-only input processors rewrite the TRANSIENT prompt and never mutate
  durable history. `openai-tool-search-history-compat.ts` canonicalizes the
  tool-search CALL item reference and asserts the output's reference is DISTINCT
  from its call's — not merely present. `openai-duplicate-item-compat.ts` drops
  stale duplicated `rs_`/`fc_`/`call_` references while keeping the result
  structurally valid.
- Do not weaken the distinctness assertion to an existence check, and do not
  replace either seam with `patchedDependencies` or a lossy history filter. The
  removal condition is self-detecting: the spec asserts all three upstream
  behaviours against the installed SDK, so the fixing release turns a test red.
- Keep browser-safe agent subpaths free of `@ai-sdk/*`, `undici` and `node:`
  builtins — only the five subpaths in
  `packages/agent/config/browser-safe-subpath-aliases.mjs` are aliased, and one
  reaching an `@ai-sdk` module drags a Node HTTP stack into the renderer bundle
  (R2 in `docs/agents/mastra-boundary.md`).

**OpenRouter model metadata.**

- Desktop exposes `GET /assistant/openrouter-model?model=<provider/model>`: it
  resolves the stored key in main, validates exact model identity, positive
  context/output limits, bounded supported parameters and the full reasoning
  object, and keeps a bounded five-minute cache. A refresh failure may return a
  prior snapshot only as explicit `stale-cache` data with a warning; a first
  failure is a visible 502. An unknown model surfaces unavailable limits instead
  of guessing.
- The renderer validates the snapshot before using it for the context meter,
  derived input budget and output maximum; a configured limit above the live
  maximum disables send with an explicit correction message. While editing the
  numeric output field, an empty, fractional, below-minimum or above-maximum
  value stays a visible uncommitted draft with an inline error and disables send
  — never clamped, never persisted.
- `mergeCatalogBudgetCeilings` clamps the fixed `qwen/qwen3.8-flash` route to its
  static catalog ceilings. Do not apply that route-specific rule to other models
  without equivalent fixed-route evidence.
- OpenRouter's canonical token-limit errors stay typed through the stream
  boundary, and every provider shares the forensic envelope
  `run.failed.metadata.runError`: stable `code`, bounded `message`/`causeChain`,
  validated `httpStatus`, bounded `providerRequestId`, and a literal allowlist of
  rate-limit/retry-after/request-id response headers. Bodies, request headers,
  URLs, secrets and retry data are excluded rather than sanitized after the fact.
  Consume it through `readProviderRunError`/`isProviderRunError`.

**Assistant status and provider availability.**

- Status resolves in order: `window.assistant.getUrl()`,
  `window.assistant.url`, then `/api/assistant/status`.
- An enabled Hosted Web status advertises its trusted primary runtime pair plus
  every configured provider in the stable priority OpenAI, Anthropic, Google,
  OpenRouter. The primary pair is atomic; incomplete, unknown, duplicate or
  inconsistent metadata fails visibly, and Hosted Web skips renderer discovery.
- Desktop's `providers` list is a validated SEED, not an exhaustive catalog: the
  app shell merges it with renderer discovery so settings-owned, reachable or
  force-enabled local runtimes stay selectable.
- `AssistantProviderSource`, provided at the `AssistantChatPanel` composition
  root, is the required explicit boundary — a missing provider throws.
  `authoritative` derives synchronously during render; `discovery` subscribes one
  shared external resource to the secrets-store revision and the immutable
  local-runtime snapshots, so unrelated settings never trigger keychain
  enumeration or probes.
- Every refresh carries a monotonically increasing generation, so a superseded
  request cannot publish late. Discovery failures stay visible as a panel notice
  while explicit seeds stay rendered, and block the composer only when no usable
  provider remains. Never convert a failure into an empty successful result.
- Idle and loading snapshots pause persisted-model reconciliation; error
  snapshots do not, so a failed sibling probe cannot leave a disappeared provider
  selected forever.
- The reconcile is a PURE DECISION, not an effect:
  `packages/app-shell/src/assistant-panel/model-selection-reconcile.ts` returns
  one `{kind: 'keep' | 'select' | 'clear'; reason}` and the hook holds no policy.
  Branch order is load-bearing — built-in-local seeding, discovery pause,
  provider availability, the local-runtime leg, registry re-selection — so a new
  case belongs in the pure module. Built-in-local seeding is gated on the
  render-captured selection while every other branch reads the live store;
  collapsing the two is a separate deliberate change.
- Desktop status reports each unreadable stored credential as a validated
  `providerErrors` entry, so one never hides other working providers, and an
  environment credential suppresses a stale stored-key read failure. Keyless
  runtime availability stays in `providers` while provenance is reported
  separately in `providerKeySources`, whose entries are exactly
  `{provider, source:"stored"}` or `{provider, source:"env", envVar}` — values
  never cross HTTP or IPC.
- An invalid desktop environment file leaves the server reachable but makes
  `/assistant/status` return `assistant_configuration_invalid` with only safe
  logical-file failure metadata; the shared validator maps it to a visible error
  state and never falls back to stored keys.

Implementation: `packages/app-shell/src/hooks/use-assistant-availability.ts`.
Evidence: `assistant-providers/local-runtime-fetch-receiver.md`,
`assistant-providers/local-runtime-catalogs.md`,
`assistant-providers/local-provider-entrypoints.md`,
`assistant-providers/credential-inventory.md`,
`assistant-providers/typed-provider-credentials.md`,
`assistant-providers/desktop-env-files.md`,
`assistant-providers/provider-credential-errors.md`,
`assistant-providers/memory-credential-authority.md`,
`assistant-providers/hosted-web-boundary.md`,
`assistant-providers/openrouter-strict-content.md`,
`assistant-providers/reasoning-dimensions.md`,
`assistant-providers/effort-vocabulary-mirrors.md`,
`assistant-providers/openrouter-auto-profile.md`,
`assistant-providers/openai-history-compat-seams.md` (its `undici@7.28.0` and
`@ai-sdk/provider@4.0.7` figures are historical — the tree now carries
`undici@7.29.1` only and `packages/agent` declares `@ai-sdk/provider` 4.0.10),
`assistant-providers/openrouter-model-metadata.md`,
`assistant-providers/assistant-availability-boundary.md`.
Guard: `packages/local-runtime/src/__tests__/local-runtime-fetch-receiver.test.ts`,
`packages/assistant-contract/src/__tests__/provider-credential.test.ts`,
`apps/desktop/src/__tests__/secrets.test.ts`,
`apps/desktop/src/__tests__/main/{ipc-secrets,desktop-env,env-example-contract}.test.ts`,
`packages/settings-ui/src/settings/secrets/__tests__/credential-inventory.test.tsx`,
`apps/desktop/e2e/secrets-settings.test.ts`,
`scripts/__tests__/provider-env-keys-mirror-contract.test.mjs`,
`packages/assistant-service/src/__tests__/request.test.ts`,
`packages/agent/src/__tests__/openrouter-strict-content.spec.ts`,
`scripts/__tests__/{openrouter-provider-mirror,ai-sdk-anthropic-mirror,ai-sdk-openai-mirror}-contract.test.mjs`,
`packages/assistant-ui/src/__tests__/composer-effort-control.test.tsx`,
`apps/desktop/src/__tests__/assistant-server/openrouter-model-metadata.test.ts`,
`packages/assistant-contract/src/__tests__/provider-registry-frontier-models.test.ts`,
`packages/app-shell/src/__tests__/use-configured-assistant-providers.test.tsx`,
`assistant-ui-panel-wrapper-provider-seeds.test.tsx`, and the named-reason unit
tests in `packages/app-shell/src/assistant-panel/__tests__/`.

### Provider catalog data ownership

Per-provider and per-model VALUES do not live in `provider-registry.ts`.
Ownership is split three ways, and editing the wrong half is the common mistake:

| File | Owns |
| --- | --- |
| `packages/assistant-contract/src/provider-catalog.json` | Every provider and model ROW. |
| `packages/assistant-contract/src/provider-catalog-schema.ts` | Runtime validation (`parseProviderCatalog`) plus the `Parsed*` inferred types. |
| `packages/assistant-contract/src/provider-registry.ts` | The `ProviderDefinition` / `LlmModelDefinition` / `EmbeddingModelDefinition` TYPES and accessors. |

- The schema is a REQUIRED boundary: `resolveJsonModule` widens JSON literals,
  so `parseProviderCatalog` is what checks rows — once at module load, throwing
  with the offending `provider.model.field` path. There is no partial-catalog
  mode.
- Every object is a Zod `strictObject`, so a misspelled optional key fails
  instead of being dropped. `_note` is the one non-runtime key and is stripped
  before any consumer sees a definition.
- Adding, removing or retyping a catalog field means editing the schema AND the
  interface in the SAME change.
- Catalog object keys are alphabetical at every depth, and that is enforced:
  `findCatalogKeyOrderFailures` in `scripts/model-catalog-migration-contract.mjs`
  enforces the order (`pnpm lint:model-catalog-migrations`, already a CI lint),
  because Biome's `useSortedKeys` assist does not reach JSON object keys. A
  wrong order fails naming the entry; nothing is reordered for you. ROW order is
  deliberately unchecked — providers and models are curated.
- Scripts read the JSON directly rather than through the package; do not
  reintroduce an AST walk over a TypeScript literal. The DB `models` mirroring
  rules stay in `docs/agents/database.md`.

Evidence: `assistant-providers/provider-catalog-ownership.md`.
Guard: `packages/assistant-contract/src/__tests__/provider-catalog-schema.test.ts`,
`scripts/__tests__/model-catalog-migration-contract.test.mjs`.

#### Model pricing is per-ROUTE, not per-model

- Declare each row's `pricing` from the source that BILLS that route: a
  first-party `openai` row from developers.openai.com, an `openrouter/*` row from
  OpenRouter's live Models API (per-token decimals × 1e6 to reach $/MTok).
- Two rows for the same underlying model may carry different rates. A divergence
  between a direct row and its OpenRouter twin is EXPECTED DATA, not drift — do
  not "fix" one row to match the other, and do not argue equivalence from two
  catalog rows agreeing with each other.
- It is recorded rather than resolved: OpenRouter is the route that bills the
  user, provider-reported cost stays authoritative at runtime, and a declared
  rate is a display estimate.
- An `openrouter/*` row's `contextWindow` and `maxOutputTokens`, and the live
  metadata reader's, are the route's `top_provider` pair, for EVERY row. The
  model-level `context_length` stands in only when `top_provider.context_length`
  is null (router meta-models); an absent field is malformed and throws, and a
  null output limit means the row declares none. Why: `contextWindow` sets the
  compaction limit, and a larger model-level window may be served by one
  provider only.

Settled: the 4/15 beside OpenRouter's 2/10 for `gpt-5.6-sol` is a declared
`min_prompt_tokens: 272000` tier, so 2/10 is that route's base. BST-1804 re-read
both on 2026-09-23: OpenAI's own >272K tier is 8/30, so the direct 4/20 is not a
mis-read tier; the gap is genuine per-route data, recorded, not explained. The
same pass re-priced the direct `openai` block from developers.openai.com.
Evidence: `assistant-providers/model-pricing-per-route.md` (also the GLM-5.3
context-window record).
Guard: `packages/assistant-contract/src/__tests__/provider-registry-pricing.test.ts`
(pins both rows AND asserts they differ);
`auditOpenRouterLimits` in `scripts/openrouter-pricing-audit.mjs` enforces the
`top_provider` pairs against the live Models API (see the audit section below);
`openrouter-model-metadata.test.ts` pins the live reader's pair and null-only
fallback.

#### Read the BASE rate, not the rate in force right now

- `pricing.prompt` / `pricing.completion` are the rate AT READ TIME. Two
  `pricing.overrides` shapes move them: `min_prompt_tokens` long-context tiers
  and `utc_days`/`utc_start`/`utc_end` surge bands. Separately, `<id>:batch`,
  `<id>:free` and `<id>:nitro` are distinct routes with their own prices.
- Record the standard route's base rate. On a route with clock bands that means
  THE CHEAPEST BAND — not "the rate outside every band" (a payload leaving part
  of the week uncovered is rejected outright) and not the modal band.
- The audit recognises each shape by POSITIVE evidence and throws on an entry
  matching neither or mixing both; classifying by elimination is fail-open,
  because the band reader defaults every absent UTC field. A third shape gets
  read by a human and taught to the script.
- Run `pnpm run audit:openrouter-pricing` when adding, re-pricing or re-limiting
  a row; it audits rates AND the `top_provider` limit pair. It is deliberately
  not in `lint:ci`: the fact lives upstream and OpenRouter re-prices
  weekly, so a network gate would fail PRs for reasons outside them and skipping
  on a network error would be silent degradation.

Settled: the known limit of the cheapest-band rule is a promotional window priced
below the standing rate; it is recorded rather than guessed around.
Evidence: `assistant-providers/openrouter-pricing-audit.md`.
Guard: `scripts/__tests__/openrouter-pricing-audit.test.mjs` (offline derivation
against real payload shapes, including one surge payload captured at a peak and
an off-peak moment, and the limit-pair check with its null-only fallback).

#### `is_enabled` is not evidence of user intent

- New catalog rows ship `is_enabled = false` (legacy rows from migrations 033/057 may
  ship enabled); migrations preserve the toggle with `is_enabled = models.is_enabled`.
  Only `initializeProviderModelDefaults` enables a row without the user, driven by `PROVIDER_MODEL_DEFAULT_POLICIES`.
- That map is exhaustive over `SupportedProvider`: `all`, `seed`, or `null`,
  defined in `provider-model-default-policies.ts`. `null` holds exactly when
  `authType === 'none' || !capabilities.llm`, pinned by test, not a list.
- "Untouched" is `!is_enabled` PER ROW plus `updated_at === created_at`; `all` gates PER ROW
  on it, `seed` gates PROVIDER-WIDE via `hasExplicitProviderModelChoice`. Catalog upserts must never write `models.updated_at` or `created_at`.

Evidence: `assistant-providers/model-enablement-defaults.md`.
Guard: `provider-model-default-policies.test.ts`, `model-registry-store.test.ts`,
`use-provider-model-defaults.test.tsx`. The `models.updated_at`/`created_at` rule is guarded
by `scripts/__tests__/model-catalog-migration-contract.test.mjs`.

### Provider registry auth metadata

- `ProviderDefinition` types the per-provider auth metadata and
  `provider-catalog.json` carries the values; that pair is the ONLY source.
- `authType: 'api_key' | 'oauth_subscription' | 'aws' | 'none'` is REQUIRED on
  every provider. Keyless-ness DERIVES from `authType === 'none'`, never from
  "declares no env keys" — `openai-codex` declares `envKeys: []` precisely
  because it is interactive OAuth only.
- `docsUrl?`, `keyFormatHint?` (vendor-documented stable prefix — omit rather
  than guess) and `keyNotes?` (rendered verbatim in Settings) complete it.
- Derive behavior through `providerAuthType(id)` /
  `getProviderDefinition(id).runtime`. Lookups on ids not statically typed
  `ProviderId` use the non-throwing `findProviderDefinition`: an out-of-registry
  id must reach a documented fallback, never a TypeError.
- Settings renders key metadata generically — no `provider === '...'` branches.
  `PROVIDER_COLOR_MAP` is compile-time exhaustive over `SupportedProvider`; its
  hash fallback serves only dynamically discovered runtime ids.
- The known remaining hand-sites are enumerated in evidence. Do not silently
  grow that list.

Evidence: `assistant-providers/provider-registry-auth.md`.
Guard: `packages/assistant-contract/src/__tests__/provider-registry-auth.test.ts`,
`packages/agent/src/__tests__/{runtime-configuration,tool-output-limits,tool-pipeline-provider-runtime}.spec.ts`,
`packages/assistant-service/src/__tests__/request.test.ts`, and the `satisfies`
in `packages/ui/src/model-picker/utils/provider-colors.ts`.

### Provider credential seam

The credential path is TYPED end to end; the bearer-key string is a projection of
it, not the contract. Three layers, each with one owner.

- **Reader types** (`packages/assistant-service/src/ports.ts`):
  `ResolvedProviderCredential` adds `source: 'env' | 'stored'`, and
  `source: 'env'` entries are always `api_key`. `ProviderCredentialReader` is
  the typed reader `prepareAssistantPostRequest` consumes — `undefined` means
  not configured, and a secret-read failure THROWS.
- **The string reader is a migration shim**, derived only via
  `createProviderApiKeyReader(typedReader)` in
  `assistant-service/src/provider-credential-projection.ts`: `api_key` → `.key`,
  any other type throws the SecretReadError-shaped `credential_type_unsupported`
  built from the shared `describeSecretReadError` text. A structured credential
  is NEVER stringified, and the credential-type narrow lives in ONE place per
  layer. Accepted limitation: persistent memory and embeddings stay
  api_key-only.
- **Factory auth input** (`packages/agent/src/providers/provider-auth-input.ts`):
  `createProvider(provider, auth?, model?, runtime?)` takes a discriminated union
  — `api_key`, `custom_fetch` (threads an injected fetch through
  `providerFetchOptions`) and `aws` — and every switch over it is exhaustive.
  Provider cases whose model config is a Mastra descriptor, and the local host
  client, throw typed (`bearerApiKeyOnly`) rather than silently dropping a fetch.
  Every secondary SDK client shares the seam: a bare-key client under
  `custom_fetch` would send the dummy key to the real API.
- An `aws` input must carry `apiKey` XOR `credentialProvider`.
  `assertExactlyOneAwsCredential` enforces it inside
  `assertValidProviderAuthInput` and is RE-asserted in the factory's `bedrock`
  case, so a direct caller cannot slip past. Neither present →
  `MISSING_AWS_CREDENTIALS_DETAIL` (the AI SDK would otherwise sign with ambient
  environment credentials); both → `CONFLICTING_AWS_CREDENTIALS_DETAIL`.
- `credentialProvider` is TYPED through the import-free
  `providers/aws-credential-identity.ts`, so this browser-reachable seam keeps
  ZERO edges — not even type-only — to the Node-only
  `@aws-sdk/credential-providers`. Its fidelity is compile-checked at
  `createAwsCredentialChain`'s return statement.
- **Threading rule (do not relitigate):** the auth input travels as a DIRECT
  parameter the whole way down — `runAssistantTurn` → `initializeAgentStream` →
  stream options → `MastraAgentRuntimeOptions.authInput` →
  `resolveRuntimeConfiguration` → `instantiateLanguageModel` → `createProvider`.
  Credentials never enter RuntimeData or a Mastra RequestContext, because
  `RequestContext.toJSON` drops functions and a `custom_fetch` closure would
  vanish silently.
- A threaded auth input is AUTHORITATIVE — no fallback into runtime/env key
  resolution; supplying both `resolved` and a different `authInput` throws typed.
  Hosted Web is a PROJECTION of the prepared typed credential, with no string
  re-mint.

Evidence: `assistant-providers/provider-credential-seam.md`.
Guard: `packages/agent/src/__tests__/{provider-factory.auth-input,runtime-configuration,persona-pinned-model}.spec.ts`,
`packages/assistant-service/src/__tests__/{request,run-turn}.test.ts`,
`packages/assistant-contract/src/__tests__/provider-key-resolution.test.ts`,
`apps/desktop/src/__tests__/main/provider-credentials.test.ts`,
`apps/desktop/src/__tests__/provider-api-key.test.ts`.

### Credential-verification probes

- `apps/desktop/src/assistant-server/provider-verification.ts` runs the cheapest
  authenticated call that proves a stored credential: bounded TTL cache with
  `live`/`fresh-cache` provenance, single-flight per (provider, credential
  digest), 10s timeout, NO retries. Only `verified`/`verified_limited` earn the
  60s success TTL; failures cache for 3s (click-storm dedup only), and the cache
  timestamp is sampled AFTER the probe resolves.
- Exposed as `GET /assistant/verify-provider?provider=<id>` behind the same
  origin/auth gates as the metadata endpoint. The renderer sends only the
  provider id; credentials resolve main-side through the typed reader.
- The renderer seam `verifyProviderCredential`
  (`packages/app-shell/src/verify-provider-credential.ts`) is a plain async
  FUNCTION, not a hook: settings-ui owns the probe UI but cannot import
  app-shell. React state lives in `use-provider-verification-state`.
- Keep the status semantics distinct through the ONE shared HTTP classifier:
  `verified` = 2xx; `verified_limited` = authenticated but not fully successful
  (403 permission-scoped, 429 rate-limited or out of quota); `invalid` = the
  endpoint rejected the credential (401, or google's documented `API_KEY_INVALID`
  400); `unreachable` = no auth verdict obtainable — wrong-key vs wifi-down MUST
  stay distinct; `not_applicable` = authType `none` only, with zero network calls
  and zero credential reads.
- Derive failure `detail` from the HTTP status ONLY — bodies can echo request
  headers. An `api_key` provider without a declared probe throws; never guess an
  endpoint. Keys never enter URLs: google uses the `x-goog-api-key` HEADER, never
  the documented `?key=` param.
- The aws profile-chain probe resolves the chain itself rather than making an
  HTTP call, maps onto those same statuses (resolved → `verified_limited`,
  `sso_expired`/`no_credentials` → `invalid`, unknown → `unreachable`), and is
  bounded by the probe's own `requestTimeoutMs`. Its `detail` comes from a
  bounded shape map and never interpolates the raw SDK message.

Settled: chain resolution earns `verified_limited`, not `verified` — it never
touches Bedrock. Evidence:
`assistant-providers/credential-verification-probes.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/provider-verification.test.ts`,
the verify-provider block in `status-endpoints.integration.test.ts`,
`packages/assistant-contract/src/__tests__/provider-verification.test.ts`, and
the probe-coverage contract test iterating registry `api_key` providers against
the probe table.

### Amazon Bedrock

Registry entry `bedrock` (`authType: 'aws'`, `runtime: 'hosted'`, LLM-only) with
two live auth forms under one authType: a Bedrock API bearer key and the AWS
default credential chain (SigV4). The stored credential's `mode`
(`bearer | profile_chain`) discriminates them; exactly one reaches the factory
per request.

- **Auth precedence is four rungs on two orthogonal axes**, decided in ONE place,
  `readProviderCredential` (`apps/desktop/src/provider-api-key.ts`): env bearer,
  stored bearer, env chain, stored chain. Rung 2 deliberately outranks rung 3 —
  do not relitigate: a bearer key is explicit and Bedrock-specific, while an AWS
  environment is ambient and often set for unrelated tooling. An env bearer key
  pairs with `AWS_REGION`; every stored credential carries its OWN region.
- **Env-chain activation**, stated once in `resolveAwsEnvChainCredential`:
  `AWS_REGION` is set AND no bearer credential was resolved AND (`AWS_PROFILE` or
  `AWS_ACCESS_KEY_ID` is present). The gate selects the MODE; once it passes the
  FULL chain runs and is never narrowed.
- **A missing region is a typed init failure, never a default** (do not
  relitigate). The one enforcement point is the factory validator
  (`MISSING_AWS_REGION_DETAIL`); the projection deliberately emits `region: ''`
  so a config failure rides to that actionable error instead of a misclassified
  secret failure.
- **Region FORMAT is SECURITY-enforced.** The region is interpolated into the
  request hostname, so the shared `AWS_REGION_PATTERN` / `isValidAwsRegion` is
  enforced in BOTH layers: `isAwsCredential` (a bad region is
  `malformed_credential`, never coerced) and `assertValidProviderAuthInput`
  (`INVALID_AWS_REGION_DETAIL`, static text that never echoes the value).
- Persona pins cannot target Bedrock cross-provider: `personaProviderApiKeys`
  carries bearer strings with no region seat, so an aws-authType pin throws the
  pin-unresolvable path. Same-provider pins reuse the parent's aws auth input.
- **Prompt caching is REGISTRY-driven.** Wrapper selection reads
  `LlmModelDefinition.promptCaching` through
  `packages/agent/src/providers/prompt-caching.ts`; neither the factory nor the
  wrappers may match on a model-id substring, and an undeclared route is sent NO
  breakpoints rather than a guessed dialect. A cache RATE and a `promptCaching`
  dialect travel together; an absent `cacheWritePerMTok` means "no premium",
  never "unknown".
- **Reasoning is per-model, by DIALECT.** `LlmModelDefinition.bedrockReasoning`
  is `'adaptive' | 'budget-tokens' | 'max-reasoning-effort'`, and the dialects do
  not follow vendor lines. Every Claude-family row is REQUIRED to declare one
  (absence fails rather than skips), and no non-Anthropic route may claim a
  Claude-only dialect. The dialect table lives in `@ai-sdk/anthropic/internal`,
  so re-check the pin on an `@ai-sdk/anthropic` OR an `@ai-sdk/amazon-bedrock`
  bump.
- **Bedrock reasoning depth has its own settings key, `bedrockEffort`**, and its
  own `family: 'bedrock'` availability shape (effort submenu, no thinking
  toggle): Bedrock exposes no free-form thinking BUDGET, so reusing the Anthropic
  pair would leave the toggle writing a budget the request builder drops.
  `BEDROCK_REASONING_EFFORTS` is the per-dialect OFFERED list, narrower than the
  type; an unoffered effort yields NO provider options.
- Visibility projects through `resolveBedrockReasoningDisplay` onto
  `reasoningConfig.display`, attached to the `adaptive` dialect ALONE. That is an
  ABSENT knob on the other two dialects, not an ignored setting.
- **`providerOptions.bedrock` is generation-only** — it carries only
  `reasoningConfig`, which Mastra must forward, so it is deliberately NOT in
  `buildGenerationProviderOptionsOption`'s strip list. Replicate the
  ollama/lmstudio stripping only if transport-ish fields are ever added.
- Replayed history is normalized for Converse (`bedrock-message-hygiene.ts`): a
  TRANSIENT Bedrock-scoped processor installed after the OpenAI seams that drops
  empty text and reasoning parts, keeps signed/redacted reasoning, drops emptied
  messages, and rewrites tool-call ids outside `[a-zA-Z0-9_-]` to `_`
  deterministically so pairs stay matched.
- Enablement: migration 100 seeds every row disabled;
  `BEDROCK_RECOMMENDED_MODEL_IDS` is this provider's `seed` entry — see
  § "`is_enabled` is not evidence of user intent".
- **The injected chain capability IS the structural proof that Hosted Web never
  resolves a chain** (do not relitigate): desktop main passes
  `createAwsCredentialChain` in BOTH places, web passes nothing, so the same
  credential throws `credential_type_unsupported` there. The string shim
  deliberately calls the projection with NO options.
- The chain module (`aws-credential-chain.ts`) is NODE-ONLY: it builds the chain
  eagerly and keeps RESOLUTION lazy, so each request picks up an `aws sso login`
  performed mid-session — which is also why a bad profile fails MID-RUN rather
  than at model construction. `classifyAwsChainFailure` translates every
  rejection to `no_credentials | sso_expired | unknown`, and `unknown` is
  first-class, never folded into the other two.
- Model ids are stored UNPREFIXED; `bedrock-model-id.ts` applies the
  cross-region profile prefix per request, precedence geo → global → verbatim. An
  AWS model card OUTRANKS models.dev, because emitting a profile AWS does not
  publish is a client-MANUFACTURED failure. Every id the module names must appear
  either in `GLOBAL_PROFILE_REGIONS_BY_MODEL` or in `NO_GLOBAL_PROFILE_MODEL_IDS`
  with a per-id reason, so a newly added id fails the suite until someone
  classifies it. GovCloud never receives `global.`.
- Exclusions: no embeddings, not a persistent-memory provider, and not in
  `HOSTED_WEB_ASSISTANT_PROVIDERS`. `@ai-sdk/amazon-bedrock` is Node-only and
  imported only from provider-factory-adjacent modules; the chain is exported
  from the agent ROOT entrypoint only.
- **The child-env scrub is a DENY-LIST**, so "absent from every set" means
  "passed through VERBATIM to repository-controlled children". Keep the three
  constants in `apps/desktop/src/desktop-env.ts` separate:
  `CREDENTIAL_ENV_FILE_VARIABLE_NAMES` (file-loadable),
  `SCRUBBED_CREDENTIAL_ENV_VARIABLE_NAMES` (a strict superset adding the
  ambient-only `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`),
  and `NON_CREDENTIAL_SUPPORTED_ENV_FILE_VARIABLE_NAMES` (`AWS_REGION`,
  `AWS_PROFILE` — configuration, deliberately not scrubbed). AWS static keys stay
  scrubbed but NOT file-loadable. The code-execution fence's `INHERITED_ENV_VARS`
  carries no `AWS_*` name and must not gain one.
- Which mode is WINNING is visible: `ProviderKeySource.authMode` is present only
  on aws-authType providers and `inspectProviderKeys` reports the WINNER (its
  env-chain pass runs LAST, mirroring rung 3). Both strict key-source parsers
  accept the chain activation names on aws providers and were relaxed from
  exact-key-COUNT to allowed-key-SET checks; an unrecognized key still rejects
  the whole payload, and a present-but-unknown `authMode` is malformed.

Evidence: `assistant-providers/bedrock-auth-precedence.md`,
`assistant-providers/bedrock-reasoning-and-caching.md`,
`assistant-providers/bedrock-credential-chain.md`,
`assistant-providers/bedrock-model-ids.md`,
`assistant-providers/bedrock-env-classification.md`. The chain evidence names
`@aws-sdk/credential-providers` 3.1111.0; the catalog pin is now 3.1127.0, so
re-measure the failure table in the module header on the next bump.
Guard: `packages/agent/src/__tests__/aws-credential-chain.spec.ts` (classifier
branches plus the EMPIRICAL real-SDK block),
`provider-factory.bedrock.spec.ts`, `bedrock-model-id.spec.ts`,
`prompt-caching-selection.spec.ts`, `bedrock-reasoning-dialect-contract.spec.ts`,
`packages/assistant-contract/src/__tests__/{provider-credential,bedrock-defaults}.test.ts`,
`packages/assistant-service/src/__tests__/provider-credential-projection.test.ts`,
`packages/app-shell/src/hooks/use-provider-model-defaults.test.tsx`,
`apps/desktop/src/__tests__/main/desktop-env.test.ts`.

### OpenAI Codex — ChatGPT subscription provider

The first `oauth_subscription` provider and the first consumer of the OAuth
engine. Legal gate: `docs/OAUTH_LEGAL_REVIEW_GATE.md` (signed, 8 binding
constraints).

- The descriptor supplies endpoints and shapes ONLY; the engine owns PKCE, the
  loopback server, the poll loop, the exchange and refresh. The non-RFC-8628
  device flow is expressed through the engine's `DeviceFlowResponseAdapter` seam
  with zero engine changes.
- Model ids are `codex/`-prefixed because the `models` table's `id` is a GLOBAL
  primary key and a bare id would hijack the platform `openai` row on upsert.
  `resolveCodexModelId` strips the prefix and THROWS on an unprefixed id rather
  than passing it through.
- Pricing is omitted on every model: usage draws on the subscription, so the UI
  renders "cost unavailable". A zero price would assert a cost we do not know.
- The factory case builds the ordinary OpenAI Responses client but REQUIRES
  `custom_fetch` auth — an `api_key` input would quietly bill the user's METERED
  account. All authentication lives in the fetch closure (`codex-fetch.ts`),
  which strips the SDK authorization header in all three `HeadersInit` shapes,
  attaches the fresh subscription bearer and account headers, rewrites the URL
  and pins `store: false`. `maxOutputTokens` is never set.
- Interactive-desktop-only (gate constraint 4) is enforced at the
  credential-resolution layer, NOT in UI copy: the projection's oauth arm
  requires an injected `oauthSubscriptionFetch` capability that only the
  interactive desktop assistant-server supplies, and that supplier re-checks per
  resolution that a `visible-ui` window exists.
- Assistant-token origin tracking records the issuing WebContents id per issuance
  and re-reads the role registry PER credential resolution, so a torn-down or
  role-cleared sender stops authorizing immediately. Attach exactly ONE
  `'destroyed'` listener per WebContents, de-duped via a `WeakSet<WebContents>` —
  per-issuance listeners stack until `MaxListenersExceededWarning`.
- ONE engine instance is shared by the IPC domain and the assistant server via
  `provider-auth-runtime.ts`; a second would carry its own single-flight map and
  REPLAY a rotating refresh token.

When changing any of this, update this section, `apps/desktop/SECURITY.md`, and
the paired tests under `apps/desktop/src/__tests__/provider-auth/`.
Evidence: `assistant-providers/openai-codex-provider.md`.
Guard: `apps/desktop/src/__tests__/main/main-platform-ipc.test.ts`.

#### Contract for any provider-listing UI (read before rendering a credential card)

`oauth_subscription` providers are **connect/disconnect**, never paste-a-key. Do
NOT treat "everything except `authType === 'none'`" as key-bearing — that
predicate will render a ChatGPT account as an API-key text field.

A surface that lists providers MUST branch on `authType`:

| `authType` | Treatment |
| --- | --- |
| `'none'` | No credential affordance (local runtimes). |
| `'api_key'` | Key input / Set / Replace / Remove. |
| `'aws'` | Key input OR profile-chain selection. |
| `'oauth_subscription'` | **Connect / Disconnect only.** No key input, no Set/Replace/Remove. Must render the connected account, a device-code alternative, and the personal-use notice (legal gate constraint 4). |

Reuse the Credential Inventory's oauth arm (`credential-oauth-actions.tsx` plus
`credential-oauth-notice.tsx`) rather than re-deriving the states. Connect
affordances are capability-gated on the `window.providerAuth` bridge — absent on
web, where the row renders read-only rather than offering a sign-in that cannot
work.

### Provider OAuth engine

Desktop-main-only, provider-agnostic engine at `apps/desktop/src/provider-auth/`,
bound by the signed `docs/OAUTH_LEGAL_REVIEW_GATE.md`, whose 8 constraints are
acceptance criteria. Do not relitigate its settled rulings (Anthropic
subscription OAuth is PERMANENTLY REJECTED).

- The descriptor contract pins the EXACT redirect URI: a busy port is a typed
  visible `port_in_use` error naming the port, NEVER a random-port fallback, and
  only test fixtures may use port 0. The engine owns device-flow loop mechanics
  while an adapter owns request/response SHAPE only. An unknown provider is typed
  `unknown_provider`, never a default.
- `ProviderAuthStatus` is the ONLY renderer-visible surface — token material
  NEVER crosses IPC (gate constraint 3). Every `provider-auth` channel registers
  `{ roles: ['visible-ui'] }`, the hidden preload excludes the bridge, and the
  credential-resolution layer calls `assertInteractiveProviderAuthSender` before
  resolving an OAuth credential.
- Refresh is single-flight per provider (rotating refresh tokens are never
  replayed), proactive inside a 120s skew, and persists rotation; a server-omitted
  refresh token keeps the old one. Fetch and body read share a 30s deadline;
  cancellation aborts fetch and cannot accept a late response.
- `invalid_grant`/revoked yields typed `reconnect_required` and KEEPS the stored
  credential — the user disconnects or reconnects explicitly, and nothing ever
  retry-loops. Rotation-then-persist-failure holds the rotated pair in memory as
  the active credential; disconnect bumps a per-provider epoch so a late refresh
  persists nothing.
- Engine-written credentials are `{ type: 'oauth', … }` in the shared secrets
  store, so factory reset already wipes them.

Threat model and loopback hygiene live in `apps/desktop/SECURITY.md`; when
changing the engine, update BOTH docs and the paired tests.
Evidence: `assistant-providers/provider-oauth-engine.md`.
Guard: `apps/desktop/src/__tests__/provider-auth/provider-auth-ipc.test.ts`
(no-token-over-IPC) and the fake-provider integration test.

### Env bootstrap visibility

- **Payload rule — NAMES ONLY, NEVER VALUES (do not relitigate).** The
  projection carries variable NAMES, file PATHS, counts and the loader's own
  failure messages — never a value, prefix, hash or length.
  `apps/desktop/src/desktop-env-report.ts` builds the name lists by intersecting
  the allow-listed NAME sets with mere PRESENCE in the process environment, so a
  value has no path into the payload by construction.
- `EnvBootstrapReport` is defined ONCE in
  `packages/assistant-contract/src/env-bootstrap-bridge.ts`. Channel
  `secrets:envBootstrap` carries the same `visible-ui` role policy as every other
  secrets channel and is absent from `hidden-preload.ts`.
- The handler re-projects the RECORDED bootstrap result per invoke and never
  re-runs loading, which is why the UI states changes apply after restart.
- Unlike `secrets:list`, this channel deliberately does NOT throw on env-file
  failures — it exists to explain that failure, so it must still answer.
- The section reads ONCE on mount. Do not add a `SECRETS_CHANGED_EVENT_NAME` or
  focus subscription: the payload cannot change without a restart, so a refresh
  would only imply the panel is live.
- Deprecation guidance has ONE source: `DeprecatedEnvVarReport.replacement` (the
  VENDOR-standard name, never the `BRAINSTRIKE_*` override), rendered through
  `settings/secrets/deprecated-env-var-message.ts`. Do not re-derive it.
- A name counts as retired based on the REGISTRY, not on whether the loader saw
  it in a file; file provenance only adds a clause to the warning.
- File ids (`dev`/`dev-local`/`user-data`) are loader vocabulary and must never
  reach the UI; `DESKTOP_ENV_FILE_LABELS` is the ONE map to real filenames, and
  the loader formats failure messages through it.
- The surface is read-only, reproduces the parser's line-precise message verbatim
  (that text is the feature — do not re-word it), and states the all-or-nothing
  consequence. The chip→row index is built from `listCredentialSlots()`, so a
  chip can never target a missing row. "Open folder" is INJECTED by the desktop
  host from `resolvePlatformBridge()` and its `{ ok, error }` result is surfaced;
  web omits the section by capability, never by an `isElectron()` check.
- Tavily's env names live in `@brainstrike/assistant-contract/tavily-env-keys`
  because both desktop and settings-ui need them; every local copy had drifted.

Evidence: `assistant-providers/env-bootstrap-visibility.md`.
Guard: `apps/desktop/src/__tests__/desktop-env-report.test.ts` (seeds a
distinctive fake value and asserts the serialized payload omits it),
`hidden-preload-contract.test.ts`.

### Anthropic `thinking` mirrors: what is deliberately NOT mirrored

`AnthropicThinkingOptions` in `packages/agent/src/types.ts` and
`packages/assistant-contract/src/runtime-data.ts` hand-mirror the provider's
`thinking` discriminated union.

- `adaptive.display` includes `'updates'`, because being strictly NARROWER than
  the provider is the bug class the guard exists to catch. Nothing emits it, and
  the provider attaches a beta header for it — derive pickers from an explicit
  const array, never from the mirrored type.
- `{ type?: never; blockBinding }` is NOT mirrored: it carries no `type` literal,
  so it is outside the guard's scope by construction, and adopting `blockBinding`
  is a feature decision rather than drift. The mirrors are knowingly narrower in
  that one dimension.

Evidence: `assistant-providers/anthropic-thinking-mirrors.md`.
Guard: `scripts/__tests__/ai-sdk-anthropic-mirror-contract.test.mjs`.

### Sampling params are never sent on a default request

- A default request carries no `temperature` / `top_p` / `top_k` on any of the
  five adapters (openai, anthropic, google, bedrock, openrouter), and no
  `createProvider` case passes sampling settings at construction.
- There is exactly ONE path by which a sampling param can reach a hosted
  provider: `RuntimeData.modelSettings` → Mastra's per-call `modelSettings` → the
  AI SDK adapter. Both Brainstrike-owned producers on that path emit
  `maxOutputTokens` and nothing else.
- `RuntimeModelSettings` has no `topK` field, so `top_k` is unreachable on every
  hosted route. Do not add one without reading this section — three vendors
  reject or deprecate non-default sampling params on their newest models.
- The Prompt Workbench (`buildPromptModelSettings`) is the only surface that can
  produce a user-set `temperature`/`topP` at all.
- A dropped value is REPORTED, not silently dropped; see "Provider call warnings"
  below. Nothing about what is SENT changed.

Evidence: `assistant-providers/sampling-params.md`.
Guard: `packages/agent/src/__tests__/sampling-params-wire.spec.ts` (per-adapter
assertion on the SERIALIZED REQUEST BODY through the real `createProvider`,
decoding both `fetch(url, init)` and `fetch(new Request(url, init))`) and the
BST-1699 block in
`packages/agent/src/mastra/runtime-assembly/__tests__/stream-options.spec.ts`.

### Provider call warnings are surfaced on the turn

- Consume the `warnings` CHANNEL, not a shape: nothing filters by `type` and the
  two text fields are read by FIELD NAME, so an unrecognized warning type still
  produces a row.
- The capture sits UNDER Mastra, at the model: `wrapModelWithCallWarningCapture`
  (`packages/agent/src/providers/provider-call-warnings.ts`) proxies
  `doStream`/`doGenerate`, and `createMastraAgentRuntime` hands the wrapped model
  to the supervisor and inherited personas. Pinned persona instances are wrapped
  at creation against the SAME per-run sink, so child and parent warnings share
  the deduplication and capacity bound. A consumer written against
  `step-start.warnings` can never fire.
- It is an OBSERVER: call arguments and stream chunks pass through untouched,
  which is what keeps the "never sent on a default request" ruling intact. Do not
  turn it into a transform — `prompt-transform-proxy.ts` is that seam.
- Coverage boundary: `createProvider` returns a model INSTANCE for every hosted
  provider plus the built-in local runtime, and a Mastra model DESCRIPTOR for
  `ollama` and `lmstudio`, which Mastra builds itself. The descriptor is narrowed
  explicitly rather than wrapped into a proxy that could never observe anything;
  every assembled run still owns a sink.
- The sink bounds every provider-controlled field with the shared
  `boundRunEventReason` redaction/200-code-point contract before retaining it,
  including model identity. All warning types share the 20-entry cap and accepted
  entries are never evicted. A warning recorded before exceptional stream
  termination is drained before the original error propagates.
- The rows themselves (kind `provider.request.warned`, `status: 'failed'`,
  always-visible, one per DISTINCT warning per run) are specified in
  `docs/agents/assistant-persistence.md`.

Evidence: `assistant-providers/provider-call-warnings.md`.
Guard: `packages/agent/src/__tests__/provider-call-warnings.spec.ts`,
`packages/agent/src/mastra/__tests__/provider-warning-run-events.spec.ts`,
`provider-warning-stream-errors.spec.ts`,
`provider-warning-run-events.integration.spec.ts`.

---

## MCP TRANSPORT SELECTION (CRITICAL)

- Every MCP server chooses its transport explicitly. The config discriminator is
  one of `stdio`, `streamable-http` or legacy `sse`; it is never omitted,
  inferred from a URL path, or changed after a failed connection.
- Protocol policy is a separate discriminator: `legacy`, `auto` or the pinned
  `2026-07-28`. Entries that omit it normalize to `legacy` without rewriting
  their JSONC, emitting a durable warning and a
  `mcp_protocol_defaulted_to_legacy` record. Explicit policy is never inferred
  from URL, transport failure, status code or server behavior. Legacy SSE accepts
  only `legacy`.
- `getProtocolEra`, `getNegotiatedProtocolVersion`, `getServerVersion` and
  `getServerCapabilities` — not exported latest-version constants — are the
  authority for the actual negotiated revision. They return `undefined` before
  connection and after close, and modern server identity may legitimately be
  absent.
- `auto` probes `server/discover`; pinned modern never initializes a legacy
  server. HTTP 401/403 retain their transport error code and status, 5xx becomes
  `EraNegotiationFailed` with its status preserved, and silence becomes
  `RequestTimeout` — none become legacy evidence. For stdio, `auto` pays for a
  disposable probe child per connection, so servers with expensive or
  non-idempotent startup should use an explicit policy.
- Both transports compose client-handler capabilities and `inputRequired` through
  one shared normalizer. The absent configuration is deliberately safe: no client
  capabilities advertised, modern input-required bounded to
  `{ autoFulfill: true, maxRounds: 8 }`. Only duplicated round-cap fields are
  rejected, with a field-specific error.
- On reconnect, the first cursorless tools, resources, resource-templates and
  prompts list each bypasses an otherwise-fresh cache entry independently.
- Production capability advertisement stays disabled until the capability engine
  returns an idempotent release lease and each transport releases it on
  invalidation, failed connect and terminal close; connection close owns handler
  lifetime today.
- Client extensions are host capabilities, not transport defaults. Both explicit
  clients start with an empty `McpClientExtensionRegistry`, so `initialize` omits
  `capabilities.extensions` unless the host registers one. A registration must
  name the exact contract revision, pass its strict settings parser and satisfy
  its complete-implementation predicate; invalid versions, malformed settings,
  duplicate registrations and incomplete implementations THROW. The registry
  never advertises a partial implementation or silently drops one.
- The registry seals immutable settings and method snapshots before a connection
  advertises them. Active core/lifecycle namespaces and notifications are never
  eligible for the bridge, and the surface is exposed only on the exactly
  negotiated `2026-07-28` revision.
- Registered contracts route through a non-colliding internal method that the
  owned transport rewrites immediately before serialization. This is not an
  arbitrary custom-method escape hatch and does not patch the SDK.
- `RegisteredExtensionDispatchLedger` is the ONE dispatch state — extend it
  rather than adding a second raw-wire substrate. Ownership lives in a
  per-transport `RegisteredExtensionDispatchScope`, and transport close clears
  ONLY that scope: a shared clear would drop a sibling transport's in-flight
  `tools/call` id or a live subscription claim. Never key raw-wire state by
  request id at ledger scope.

| Client extension | Canonical contract | Brainstrike host surface | Advertised |
| --- | --- | --- | --- |
| MCP Apps (`io.modelcontextprotocol/ui`) | Stable spec `2026-01-26`; required `mimeTypes`, currently `text/html;profile=mcp-app` | Registered: default desktop registry, sandbox startup, generation-fenced resource reader, validated frame bridge, thread-keyed ordinary admission, visible-UI consent path | Yes by default (stdio, streamable-http); off when either dial says so; sse: not registered |
| MCP Tasks (`io.modelcontextprotocol/tasks`) | Empty capability settings; results, polling, mid-flight input, durable handles, cancellation and optional notifications are one contract | Registered: `createDefaultMcpExtensionRegistry` installs the wire contracts on every stdio and streamable-http connection, and `McpDesktopTaskHost` runs the repository/lifecycle/interaction/presentation chain per negotiated generation | Yes by default (stdio, streamable-http); off when either dial says so; sse: not registered |
| OAuth Client Credentials | Empty settings plus complete client-secret or private-key JWT acquisition | Disabled: the product path is interactive user authorization | No |
| Enterprise-Managed Authorization | Empty settings plus the complete enterprise IdP/ID-JAG exchange | Disabled: no managed-enterprise product surface | No |

The registry is the host-owned source of truth for that matrix; Settings and
per-request wire proof render it.

Tasks substrate rules:

- A task id is a durable handle a client must resume after restart. The
  repository rebinds the live authority epoch across a Desktop runtime restart
  rather than persisting the host's process-local generation, and every write
  checks the exact live epoch/runtime/generation lease in SQL.
- Because a rotated or retired epoch orphans its non-terminal rows, advance the
  generation only when the server definition is replaced — never on a transport
  reconnect — and retire the epoch only for `server-removed` and
  `server-replaced`. Disconnect, restart and close leave the epoch live so the
  next `openAuthority` rebinds it; factory reset deletes the rows outright.
- `McpTaskLifecycle` is the SOLE ordered `tasks/get` poll authority: it persists
  each handle and its server timing before exposing it, registers in-flight
  creates before their first await, resumes only the exact live authority, and
  persists before publishing every update. Optional notifications only wake and
  coalesce an immediate poll; interaction consumes the post-persistence
  observation callback and never starts a second poll fleet.
- Oversized durable state persists the remote status plus a bounded blocked
  diagnostic (field, exact byte count, limit, SHA-256) and no raw payload,
  publishing neither the rejected state nor an interaction event. The row is
  terminal to local recovery rather than a false-green `working` handle.
- A `tasks/cancel` acknowledgement is not success: only an observed `cancelled`
  settles successfully. Each observation treats `inputRequests` as the complete
  outstanding snapshot and retires omitted keys.
- An absent `resultType` is `complete` per final SEP-2322; a conflicting value is
  rejected. Sampling/roots task input is unsupported.
- A lease whose requested ids were not ALL honored closes itself and rejects
  naming the rejected ids; an acknowledgement the bridge never observed, or one
  honoring ids outside the request, rejects the same way. There is no
  zero-honored-ids success state.
- The packaged Tasks verifier is a test-only lazy renderer mode guarded by BOTH
  `mode=mcp-task-harness` and Desktop test mode, and its chunk exists only in a
  renderer built with `VITE_MCP_TASK_HARNESS=1` — the packaged lane
  `test:e2e:lane:packaged-mcp-tasks` packages with it; release builds never do.
  Production registration is `McpDesktopTaskHost`, which must never import the
  harness.

Evidence: `assistant-providers/mcp-protocol-era.md`,
`assistant-providers/mcp-extension-registry.md`,
`assistant-providers/mcp-tasks-substrate.md`.
Guard: `packages/agent/src/__tests__/mcp-tasks-subscription-acknowledgement.integration.spec.ts`,
`mcp-modern-stdio-extension.integration.spec.ts`,
`mcp-modern-http-extension.integration.spec.ts`.

### Production Tasks host

- Extension registration is a host-runtime seam:
  `DesktopMcpHostRuntimeDependencies.resolveExtensionRegistry(server, context)`
  runs once per connection generation and must return a FRESH registry each time
  — a registry seals on its first projection, so one instance can never serve two
  connections. `createDefaultMcpExtensionRegistry` registers Tasks for `stdio`
  and `streamable-http` and returns `undefined` for legacy `sse`.
- `McpCoreServerFeatures` routes `tools/call` through
  `requestExtension(MCP_TASKS_CALL_TOOL_REQUEST_CONTRACT)` whenever the registry
  registers Tasks and the server advertises it; on the pinned client a core
  `callTool` answer with `resultType: 'task'` is rejected by the SDK funnel. That
  path takes exactly `{ name, arguments }`. Both dispatch paths receive the same
  SDK request options, so progress and timeout reset behave identically.
- `resetTimeoutOnProgress` re-arms the SDK's 60s timeout on EVERY progress
  notification, so the CALLER'S SIGNAL is the real deadline: the agent's per-tool
  guard aborts it and the SDK withdraws the request.
- `McpServerActor` does NOT retire a generation for an `operation`-category
  failure (`mcp-request-timeout`, `mcp-input-rounds-exhausted`,
  `mcp-list-pagination-exceeded`): those describe the CALL, not the transport.
  Every other category still poisons the generation immediately.
- **The one bounded exception is a transport that stops answering at all.**
  `mcp-request-timeout` is the only AMBIGUOUS operation code, so the actor counts
  CONSECUTIVE unanswered timeouts and INVALIDATES the transport at
  `MCP_WEDGED_TRANSPORT_TIMEOUTS` (2). Any answer of any kind resets the counter;
  a caller-side cancellation never reaches it. Invalidation is the state
  `McpHostService.invoke` already SELF-HEALS on the next call.
- `McpDesktopTaskHost` composes the repository over the existing desktop database
  (never a new PGlite), one observation port, the sole-authority lifecycle and
  the interaction coordinator per connected generation advertising Tasks on
  `2026-07-28`, then runs `recover()`. Retirement happens only AFTER the
  replacement configuration has been staged, so a replacement whose preparation
  rejects leaves the old actor connected with its session intact.
  `awaitSettlement` resolves `{ settled: false, reason: 'timeout' }` at the bound
  and never throws for a timeout. Task-scoped elicitation binds through
  `bindTaskPresenter`, not `runWithOperation`, because the
  single-matching-operation guard would misattribute provenance. The renderer
  seam is `mcp:task:status-changed` / `:list` / `:act`, all visible-UI.

Evidence: `assistant-providers/mcp-tasks-host.md`.
Guard: `apps/desktop/src/__tests__/main/mcp-server-actor.test.ts` (retirement AND
streak resets), `mcp-host-service.test.ts`,
`mcp-progress-cancellation.integration.test.ts`,
`mcp-host-runtime-tasks.test.ts`.

#### Registered extension off switch

Both registered extensions ship ON; two dials can turn one off without a new
build, and the effective state is `global AND per-server`.

- **Per-server**: an optional `extensions: { apps?: boolean, tasks?: boolean }`
  in the MCP configuration document. An omitted key is enabled; an unknown key or
  non-boolean value is a config validation error, never a coerced default.
- **Global**: `McpExtensionEnablement` persisted by main under
  `mcpExtensionPreferences.v1`, reached over `mcp:extensions:get`/`:set` and
  pushed back on `mcp:extensions:updated`. A write persists BEFORE it reaches the
  live host. A stored value that cannot be parsed is `unreadable` and fails
  CLOSED — both extensions off — because the stored value is the only record of a
  deliberate opt-out.
- `DesktopMcpHostRuntime` folds the global dials into each server's PRIVATE
  definition before staging, so a flip changes only the AFFECTED servers'
  `configRef` and runs the ordinary replacement path; a server whose effective
  state is unchanged keeps its ref, generation and live epoch. A malformed
  preference rejects that replacement and leaves the live dials alone. Nothing
  mutates a live registry.
- Disabling is absence, not degradation: `initialize` carries no
  `capabilities.extensions` entry, and with BOTH off the client is constructed
  with no registry at all. An Apps-only registry opens NO task session, so
  `McpDesktopTaskHost.track()` still throws naming the missing advertisement —
  that throw is the contract and must not be softened. `sse` remains unregistered
  regardless of either dial.
- The host snapshot carries the EFFECTIVE per-server state, which is what the
  support matrix and per-server diagnostics render — never the compiled-in
  default. Turning Apps off unmounts every mounted app for that server through
  its ordinary teardown. Factory reset clears the stored dials; a failed reset
  restores the captured dials with the rest of the snapshot.

Evidence: `assistant-providers/mcp-extension-off-switch.md`.
Guard: `apps/desktop/src/__tests__/main/{mcp-extension-preferences,ipc-mcp-extensions,mcp-host-runtime-tasks}.test.ts`,
`packages/mcp-app-host-ui/src/__tests__/mcp-app-tool-result.test.tsx`, and the
real-wire absence proofs in
`packages/agent/src/__tests__/mcp-modern-{stdio,http}-extension.integration.spec.ts`.

### MCP client input and deprecated compatibility

- Core client capabilities install through the ONE `McpClientCapabilityRuntime`
  used by both explicit clients. It projects a capability only when its complete
  handler is present; no handler means no declaration and an inbound request
  fails through the SDK's missing-capability path. Round exhaustion and malformed
  requests stay visible SDK errors.
- The desktop production resolver advertises exactly `{ elicitation }` (form and
  URL modes, default `https-only` URL policy). Roots, sampling and protocol
  logging remain absent. An explicit `resolveClientCapabilities` dependency
  replaces this default wholesale; one returning `undefined` yields
  capability-free options.
- Desktop main owns ONE process-local elicitation presenter authority. An
  explicit active-invocation registry binds only a single matching server
  operation and rejects ambiguous concurrency; no async context or untrusted
  `requestState` supplies authority. Grants are weak, settlement is once-only,
  and actor retirement covers failure, replacement, reset, disconnect and close.
- The consent surface is one IPC seam plus one app-wide modal. Detaching the
  bridge rejects every pending presentation with
  `mcp-elicitation-presenter-unavailable`; with no listener attached an inbound
  request fails closed the same way. **There is no auto-accept.**
- The dialog is non-dismissible, names its provenance in the accessible
  title/description, mirrors `validateMcpElicitationResult` client-side (never a
  replacement — main and the SDK re-validate), shows a URL request's full URL
  verbatim, and focuses Decline by default. Accept on a URL request records a
  one-use grant; only main opens the browser, and only after that accept.
- URL elicitation is validated by ONE host assertion before consent and before
  opening: HTTPS without credentials in production, HTTP only under the explicit
  loopback-development policy. Decline/cancel never call the external opener.
- Roots, sampling and protocol logging are compatibility-only and disabled by
  omission for every server. Roots are advisory hints, never filesystem grants. A
  sampling handler receives only the validated request and the outer abort
  signal, must use the already-selected provider/model, and must not append
  conversation history. Protocol logging caps entries at 32 KiB and redacts
  sensitive-key values. Review all three for removal on 2027-07-28.
- MCP Apps may register only after one reviewed implementation proves EVERY
  graduation gate together: supported MIME declaration, `ui://` resource loading,
  tool/result association, isolated sandbox and enforced CSP, validated
  bidirectional messages, permission/consent, lifecycle cleanup and renderer
  tests. A partial or text-only host never advertises the extension.
- `McpAppToolCallAuthority` accepts only app-visible tools owned by the exact
  server generation, holds every `ask` decision until its opaque host consent id
  is approved, and releases provenance on denial, cancellation, failure or close.
  Each call receives a generation-bound preparation id and a required one-use
  release callback. The preparer accepts an admission CAPABILITY rather than
  policy or invocation inputs, so it cannot recreate or bypass ordinary
  admission. Calls absent from the ordinary map fail visibly; admitted calls use
  the already-bound guard, hooks and telemetry exactly once, and replay fails
  before a second execution. Apps telemetry carries only tool name, outcome and
  duration.
- The host surface lives in the browser adapter package
  `@brainstrike/mcp-app-host-ui`; the `@brainstrike/mcp-app-host` core stays
  NodeNext-compatible and React-free so agent-side imports load no renderer code.
  App-originated `ask` renders one focus-trapped `alertdialog` at a time, exposes
  only the owned tool name and risk category, and never renders arguments or
  results.
- The packaged Apps-bridge proof runs through
  `test:e2e:lane:packaged-mcp-apps-bridge`; its harness document lives in the
  disposable user-data directory and imports the bridge module by absolute file
  URL, never from a published `dist/`. The `Native Electron Package` job runs the
  Apps proof through `test:e2e:lane:packaged-mcp-apps` against the artifact it
  just built. Production uses the IPC authority below and never imports the E2E
  implementation.

Evidence: `assistant-providers/mcp-elicitation-and-compat.md`,
`assistant-providers/mcp-apps-authority-layers.md`.

### Production Apps host

`registerMcpAppsClientCapability` defines the capability-only
`io.modelcontextprotocol/ui` contract at stable revision `2026-01-26`. It has no
extension requests or notifications and works on legacy-era connections;
`createDefaultMcpExtensionRegistry` registers it beside Tasks on every fresh
stdio or streamable-http generation, and legacy `sse` receives no registry.
Initialize advertises exactly `{ mimeTypes: ['text/html;profile=mcp-app'] }`.

- **Sandbox boundary (settled; do not reintroduce a partition).** Electron never
  creates a WebContents for an in-page `<iframe>`, so a `web-contents-created` or
  session-partition policy can never observe the app. The boundary is an
  opaque-origin `about:srcdoc` frame with `sandbox="allow-scripts"`, a
  per-document CSP meta tag, and `allow` set to `'none'` for every reviewed
  permission, inside a host-authored shell served at
  `brainstrike-mcp-app://<token>/` with the policy delivered as
  `Content-Security-Policy` AND `Permissions-Policy` RESPONSE HEADERS.
- The main window's CSP is `frame-src brainstrike-canvas: brainstrike-mcp-app:`
  — `blob:` is never a frame source. Shells bind to the registering WebContents
  id, `releaseShell` is immediate, and `will-frame-navigate` denies the shell any
  navigation and the app frame anything but `about:srcdoc`.
- **Session policy.** `installMcpAppSessionPolicy` denies every permission
  request AND check whose `details.requestingUrl` is an opaque-origin sandbox
  shell, or is `about:srcdoc` while the WebContents hosts such a frame. The
  srcdoc arm resolves the parent from the frame tree and is fail-closed, and an
  unattributable SUB-frame check is DENIED whenever the WebContents hosts a
  sandbox frame, while `details.isMainFrame` keeps the host renderer's own checks
  on Electron's default. Denials log at `warn` once per (WebContents, arm,
  permission). `will-download` cancels any download whose URL chain carries an
  MCP App shell origin. Every other requester keeps Electron's default outcome.
- **Ordinary admission is keyed by the OWNING THREAD.** `assistant-server.ts`
  registers each runtime's `mcpAppToolAdmission` as `{ runId, threadId }` — a run
  without a persisted thread publishes nothing. `McpAppPrepareRequest.threadId`
  is mandatory, and `McpAppToolResult` renders a "requires a persisted thread"
  note instead of mounting when it is absent. Preparation resolves exactly that
  thread's admission and never picks by recency.
- Registration is gated on the run being able to mount an app at all, so an
  app-free later run of the same thread does NOT supersede a still-mounted
  admission. A newer app-capable run for the same thread supersedes the older
  admission and releases its pending preparations.
- **Admission lifetime: live run → detached → superseded/retired.** While the run
  is live the admitted executor is the run's exact gated MCP tool entry. Run
  `dispose()` closes that client, so `invalidateAdmission` releases pending
  preparations and DETACHES the admission; `admit` reads only the static per-tool
  maps, so a detached prepare returns the same decision and risk category and the
  renderer consent dialog still gates `ask` tools. Detached execution is one
  host-port call, and detached calls bypass the run's tool hooks, guards and
  telemetry BY DESIGN: there is no run.
- Retention is bounded: at most one admission per thread, pinned to each admitted
  server's live host generation at detach time, dropped by a `host.watch` when a
  generation retires, and re-checked against the live snapshot generation at
  prepare because watch delivery is microtask-queued. Host close rejects the
  invoke rather than degrading.
- `prepare` reserves the renderer-supplied preparation id SYNCHRONOUSLY before
  its first await and drops the reservation on every exit path, so a concurrent
  duplicate rejects with `mcp_app_preparation_duplicate` instead of overwriting
  the first entry.
- The visible-UI-only IPC domain is `mcp:apps:prepare`, `:execute`, `:release`,
  `:prepareShell` and `:releaseShell`. `window.mcp.apps.readResource` resolves the
  server's live generation, uses the existing `mcp:content:readResource` path for
  the exact server id and `ui://` URI, then requires text content and the exact
  Apps MIME type. Hidden preloads expose no `mcp` global.

Transport, startup and ownership rules:

- Desktop Settings consumes the singleton runtime's browser-safe
  `McpHostSnapshot` through `mcp:status:get` and revisioned
  `mcp:status:updated`. Renderer state accepts only strictly newer revisions,
  tool presence never implies connection success, and connected or failed
  zero-tool servers plus negotiation/config errors remain visible.
- Startup policy is explicit per server: `automatic` permits one bounded machine
  connection attempt during discovery; `authentication-required` publishes an
  actionable status without constructing the transport. The automatic attempt
  cannot open a browser, and on needing login it closes its transport and returns
  to authentication-required without retrying on every assistant request.
- `connect`, `retry`, `cancel`, `disconnect` and `reauthorize` are explicit host
  controls; user-paced authorization is not governed by the ten-second machine
  deadline.
- Per transport: `stdio` constructs only the SDK's `StdioClientTransport`;
  `streamable-http` only `StreamableHTTPClientTransport`; `sse` only
  `SSEClientTransport`, even when its URL ends in `/mcp`. Interactive OAuth
  completion and scope step-up are Streamable-HTTP-only and throw at construction
  on `sse`; `authorizationCallbackTimeoutMs` alone throws on EVERY transport.
- **There is NO automatic Streamable HTTP → SSE fallback.** Brainstrike removes
  the URL ambiguity by requiring the user to select the transport, so a
  400/404/405 initialization failure remains visible.
- External bearer auth is desktop-main-only and reference-based: JSONC carries a
  credential reference and the renderer-visible snapshot projects only
  `malformed | missing | stored | unreadable`. The credential authority injects
  `Authorization: Bearer …` only after proving the request origin equals the
  configured resource origin and no competing header exists. No fallback to
  unauthenticated transport occurs.
- HTTP lifecycle ownership is explicit: `client-owned` connections invalidate,
  close, reconnect once and replay only a reconnectable session failure;
  `host-owned` connections invalidate and close locally without replay. Transport
  code never infers ownership, and explicit `close()` is idempotent.
- Both transports install one immutable pre-codec mapping for an absent
  `resultType`, applying only to positively modern messages and never mutating
  the parsed message. A second installation with a conflicting resolver fails
  visibly. Retire the mapping only when the pinned SDK implements the final SEP
  rule and the official `sep-2322-client-request-state` scenario still passes.
- Ownership runs in five layers: shared config grammar
  (`packages/assistant-contract/src/mcp-config.ts`), the official explicit
  clients (`@brainstrike/agent/mcp-client`), desktop host composition
  (`apps/desktop/src/mcp/host-runtime.ts`), desktop authority
  (`DesktopMcpHostRuntime`), and the agent runtime adapter
  (`packages/agent/src/mastra/mcp-runtime-client.ts`), which never constructs or
  closes an SDK client. Keep the split SDK packages out of root, browser-safe and
  Hosted Web bundles.

Evidence: `assistant-providers/mcp-apps-sandbox.md`,
`assistant-providers/mcp-apps-admission.md`,
`assistant-providers/mcp-apps-wire-layers.md`,
`assistant-providers/mcp-transport-rules.md`,
`assistant-providers/mcp-ownership-flow.md`.
Guard: `apps/desktop/src/__tests__/main/mcp-apps-session-policy.test.ts` and the
live probe in `test:e2e:lane:packaged-mcp-apps` driving both the request and the
check path.

### MCP verification harness and official conformance

The verification harness, the production official-conformance client entry, the
bounded official-runner driver, evidence schemas, and the durable official
conformance evidence links live in `docs/agents/mcp-conformance.md`. This
document keeps only the provider-facing rules: transport selection, protocol
era, auth policy, and the host runtime contract.

### MCP 2026 host architecture

This is the living production contract for the MCP 2026 migration. The dated
[architecture spike](research/bst-1478-mcp-v2-oauth-architecture-spike.md)
records source analysis and rejected alternatives; when it disagrees with this
section, this section wins.

`McpHostService` is the sole production SDK client owner. It is an Electron-main
singleton; renderers, assistant adapters, and settings code never construct an
SDK client, own an MCP child, or retain OAuth material. One server generation
owns at most one steady-state client and one stdio child. A bounded negotiation
probe may own a disposable child only when it is observed and reaped before the
generation becomes ready.

`DesktopMcpHostRuntime` is the private composition root. It transactionally maps
complete resolved transport configuration to opaque UUID refs, reusing a ref only
for deep-equal private configuration. Raw URLs, headers, commands, argv,
environment, and decrypted values remain behind that main-process map; failed
replacement never commits provisional refs. Public `enabledTools` preferences do
not participate in private ref identity; server identity, protocol, transport,
and connection material do. During an ordered replacement, actor creation
resolves staged refs first and committed refs second so an earlier self-heal
cannot lose its still-current authority. HTTP is always `host-owned`; successful
actor close reports one client and observer callback, one stdio child when
applicable, and the exact number of operations settled through that client
wrapper — known owned resources whose close promises proved terminal, not
guessed teardown actions.

The surrounding host boundary has these additional invariants:

- Configured server ids are branded, limited to 128 Unicode code points, reject prototype-sensitive names plus Unicode control/format characters with specific diagnostics, and are never recovered from dotted tool or display names. Lifecycle and error vocabularies are closed.
- Browser-safe config carries only main-owned transport UUIDs, non-secret policy, and typed credential-store references. Decrypted material stays in Electron main; transport/protocol schemas track the shared unions, and SSE accepts only `legacy`.
- Operation results use nested `{ type, result }` envelopes. Electron main parses raw results through the browser-blocked `./mcp-host-runtime` subpath and the matching SDK-v2 schema, requiring strict JSON-safe open fields before IPC.

Every actor validates negotiated status, operation results, and close reports
through the browser-blocked runtime parser before publishing or returning them.
`ExplicitHttpMcpClient` defaults to `client-owned` lifecycle so existing direct consumers retain one bounded
expired-session reconnect and request replay. Host composition must select `host-owned`: a session-invalidating 404 invalidates the connection, emits one unexpected-close signal, and returns the original failure without replay.
`ExplicitStdioMcpClient` publishes pending child ownership before connection begins, sets terminal closure
synchronously before teardown, and reaps pending and active children through one idempotent close promise. Only an active connection emits the observer signal; pending failures reject connect directly.

Terminal closure also SETTLES THE CONNECTION'S IN-FLIGHT TRANSPORT WRITES
(`installMcpStdioSendClosure`). Node's parent-side pipe to a child that has
exited returns `false` from `write()` and never emits `'drain'` again, and the
SDK's `StdioClientTransport.send()` resolves only on that `'drain'`, so a message
written into a dead child's pipe never settles — which used to hang
`Client.listen()` and the whole connect sequence. Closure now rejects those
writes visibly. Never wrap this in a swallowing catch, and never assume a stdio
`send` promise settles on its own. WHERE the closure fires is itself an
invariant: `invalidateConnection` severs FIRST, before its `disconnected`
short-circuit; `closeConnection` severs LAST, after its teardown `allSettled`, so
it cannot poison the connection's own farewell traffic or blame a dead pipe for a
live child's ordinary backpressure.

Actor state is single-writer and generation-bound. A failure remains the latest
snapshot through teardown; observer exceptions are isolated and diagnosed.
Because `change` is that unconditional single writer, a successful client
handshake never publishes `connected` once a failure has been recorded.
Public actor close is idempotent and never rejects. Its report includes an
explicit sanitized `failures` array in addition to non-negative safe-integer
resource counters, so a failed teardown cannot masquerade as an all-zero clean
proof. Every returned report and nested failure array is frozen in the actor
process, and there is deliberately no post-error `disconnected` event.
Raw internal causes reach one required main-process diagnostic sink; they may
contain credentials and must never cross renderer IPC or bypass the platform
redaction path.

`McpHostPort` exposes exactly `snapshot`, `invoke`, `watch`, `replaceConfig`,
`control`, and `close`:

- `snapshot` returns token-free authority state, negotiated protocol revision, server identity, capabilities, auth/lifecycle status, and bounded diagnostics.
- `invoke` accepts a closed typed operation union. There is no raw `request(method, params)` escape hatch and no method-per-SDK-verb public API. BST-1471 extends it with resources, resource templates, prompts, completions, and resource subscription control.
- `watch` is filtered and token-free. Subscribers cannot obtain the host, SDK values, credential handles, or another server's private events.
- `replaceConfig` is ordered with invocation and lifecycle work. It advances the server generation, rejects new work against the retired generation, settles or cancels owned work explicitly, and closes old transports before publishing the replacement as ready. It never mutates a live client in place.
- `control` accepts only the closed `connect` / `retry` / `cancel` / `disconnect` / `reauthorize` action union; each action returns the resulting token-free snapshot, and cancel stays actionable during connect.
- `close` is terminal and proves that every owned client, request, subscription, callback listener, loopback port, probe, and child process is gone.

Each connected actor owns one per-server catalog with independent section errors.
Modern connections register change handlers once and open `subscriptions/listen`
with the advertised-capability intersection, re-listening with a three-attempt
bounded backoff only after remote closure; legacy connections never send it.
Settings may browse catalog metadata and errors, but resource and prompt bodies
are never eager model context.

A retirement close report containing failures still removes that actor from
routing and reconciles the publisher to the retained actor set before
`replaceConfig` rejects. The exact frozen aggregate then latches the host: every
later replacement rejects with the same proof, while retained actors remain
invokable. The only recovery is terminally closing and reconstructing
`McpHostService`. Terminal `close` aggregates that ledger with all actors current at shutdown,
so its one frozen report proves cleanup across the complete host lifetime without
retaining closed transports.

A config publication failure closes every provisional actor and records their
detached reports before it attempts to republish the retained authority. If
retained-authority reconciliation itself fails after otherwise clean cleanup, the
host latches a frozen `mcp-host-publish-failed` proof. No unpublished actor
remains owned or routable. Retained actor snapshots are re-read after every
awaited retirement or provisional cleanup, so a legitimate transition during
teardown cannot be overwritten by a stale higher revision.

The host publisher alone owns a monotonic revision sequence beginning at zero.
Config and actor publications advance it only for a material state change.
The queued event and returned snapshot are separate detached values.
Filtered watches receive only events affecting one of their configured server ids
and may therefore observe revision holes. Empty configured-server-id filters are rejected visibly
rather than registered as silent no-op subscriptions; non-empty filters may name
a future configured server.
Actor transitions must exactly match the config-owned generation, protocol policy, and transport.
Lower and higher generations, policy mutation, and transitions from a removed
server throw typed attributable errors.
Terminal host close invalidates queued and future watch registrations because the
closed watch DTO has no terminal event variant, includes their exact count in the frozen close proof,
and suppresses actor state callbacks after closure begins so
normal teardown cannot create false listener-failure diagnostics.

Desktop lifecycle composition lives in `ipc-mcp.ts`. Shutdown first stops and
drains the assistant HTTP server, then closes MCP configuration admission, stops
the file watcher, awaits every tracked load/replacement/discovery, clears the
renderer projection, and terminally closes the singleton host. Process, terminal,
command-session and LSP reapers start in the same settlement batch, so a hung
drain cannot prevent those attempts. Factory reset uses the same fence but does
not close the singleton: it installs explicit empty authority, purges
projections, and keeps admission closed through the enclosing purge and visible
renderer replacement, waiting for the replacement tree's explicit renderer-ready
ping. A failed purge restores the captured pre-reset authority. Every config IPC
operation joins the lifecycle barrier before its first asynchronous side effect.
The tracked operation queue is deliberately non-reentrant: code already inside it
must use the `*ForLifecycle` helpers with the captured epoch. File-watcher
callbacks and the user-paced native config picker stay outside that queue.

Assistant adapters may discover and invoke but cannot mutate auth or
configuration. Renderer IPC receives only snapshots and explicit Settings
actions. Opaque server, invocation, continuation, task and Apps ids are never
reconstructed from display names.

The startup policy prevents unsolicited interactive OAuth. Native HTTP
`oauth-user` entries that omit startup normalize to `authentication-required`;
explicitly selecting `automatic` is invalid, and an `npx -y mcp-remote ...` shape
normalizes the same way. Automatic attempts may reuse or refresh credentials, but
the provider rejects browser authorization before arming a callback or calling
openExternal, so config loading and startup discovery cannot spawn a browser.
User-paced stdio auth omits Brainstrike's absolute request budget and uses the
Node platform-maximum timer required by the SDK 2.0.0 public request API; that is
an SDK constraint, not a product auth deadline.

Production migrates atomically to `@modelcontextprotocol/client@2.0.0`; v1 and v2
class instances never cross the host boundary. The release tag used by this
contract peels to `cc4b41617ce3601b1290d67216ea0b194a3cd9ac`, and modern
negotiation targets MCP `2026-07-28` while retaining explicit legacy policy.
Post-release SDK behavior requires an explicit dependency update and its own
regression proof; a transitive package or later upstream `main` is not evidence.

Remote OAuth is owned entirely by Electron main through the SDK OAuth provider
and a dedicated encrypted MCP credential store, separate from model-provider
credentials and partitioned by configured server, authorization issuer,
protected-resource URI, client identity, and granted scope set. Browser
redirects, PKCE verifiers, authorization codes, tokens, and client secrets never
cross preload or renderer IPC. Disconnect, config removal, revocation, and
factory reset clear both encrypted records and in-memory state; a storage failure
is visible and never converted into an unauthenticated fallback.

Explicit Connect cancellation spans the entire control request, including a
background-to-interactive handoff, rather than borrowing the first transport
attempt's signal. The host republishes `provider.authSnapshot()` after connection
settlement, including failure after SDK credential invalidation, so Settings does
not retain "stored" after an `invalid_grant`. A cancelled attempt that finishes
cleanup late cannot overwrite a replacement provider's credential facts.

Production host composition creates the OAuth provider for stored-grant
background discovery and explicit Connect or Reauthorize. Only an explicit true
authorization option permits browser consent. It passes both `provider.fetch` and
`authProvider` to `ExplicitHttpMcpClient`, and for OAuth-user Streamable HTTP the
one-shot `takePendingAuthorizationCallback(signal)` source, which the agent
client alone consumes; absence of a pending callback returns `undefined` instead
of guessing. Disconnect and Reauthorize close the selected actor first, then
clear only its canonical identity; Reauthorize alone immediately begins a fresh
connect. The browser-safe snapshot exposes no tokens, codes, verifiers, secrets
or credential-store keys, and OAuth records are partitioned so a URL or scope
change cannot silently reuse the previous grant.

The `2026-07-28` authorization-server migration contract requires a challenged
bearer request to rediscover protected-resource metadata before selecting the
next authorization server. A context-free token read marks that issuer's
discovery stale; only successful replacement token persistence for that issuer
clears the mark. Client information, tokens and discovery remain
issuer-partitioned, so migration re-registers instead of replaying credentials.

Linear's native configuration uses Streamable HTTP at
`https://mcp.linear.app/mcp` with `auth.type: "oauth-user"`; Brainstrike does not
wrap it in `mcp-remote`. That endpoint is read-write by default; hard read-only
uses `/mcp/readonly`, or the standard resource with only the `read` scope. Each
workspace must use a distinct configured server identity.

The fault-injection lab: the package exports `./faults` only after every fault variant, declaration key, match key, occurrence, reachability rule, and coordinate shape is validated.
Fault plans are closed declarative data created only by `createMcpLabFaultPlan`;
structural substitutes are rejected. The factory bounds and snapshots declaration arrays with indexed reads, validates diagnostic-safe ids and exact coordinates, freezes factory-branded plans, and snapshots each consumption before lookup. Occurrences must be reachable, and fault kinds are bound to compatible coordinates.
The era method sets match the released `@modelcontextprotocol/core@2.0.0` codec
registry at `cc4b416`. Authentication, era, transport, fixture, and execution
discriminators are closed. `assertScenarioFaultCompatibility` is the single mapping from a canonical scenario plus execution topology to those validators; callers never translate `streamable-http` into a lab transport.

HTTP fault execution is private package machinery; the executor, qualifier, correlation registry, OAuth hooks, and dropped-response sentinel are not public exports. A scenario snapshots and compatibility-checks its branded plan before
atomically claiming it and before allocating a handler, listener, OAuth record, or
child. Only the private claimed capability may consume faults. A claim is
single-session and permanent even when later startup fails; a plan consumed
through its public test API, attached twice, or mutated publicly after claim fails
visibly before another allocation.

HTTP in-process, loopback, OAuth, and stdio sessions all execute
`shutdown/transport/close` delay and cleanup-error faults. Stdio also executes
`child/spawn` delay and real `child/stderr` after spawn and `child/exit` only
after the official server has answered the handshake. The stdio owner peeks at
child configuration without consuming it, then commits stderr and exit faults only
after the corresponding control write or signal succeeds. Spawn failure therefore leaves stderr and exit untriggered.
Injected stderr is emitted by the real child but diagnostics retain only a bounded
byte aggregate. Exit-code control uses a private per-session mode-0600 temporary
channel; close tears down the delegate before joining blocked sends and removes
the control directory only after child ownership is released; the verifier proves the captured PID reaches `ESRCH`.

Stdio protocol sends are serialized in invocation order and qualified with the
pinned SDK client schemas plus its era classifier. Response-shaped, batch,
structurally invalid, wrong-era, and unsupported messages still reach the delegate
but never advance occurrences. A delay precedes the matching delegate send, and
the runtime commits it only after that send succeeds. Response drop is also
committed only after successful send and suppresses exactly one matching typed
response id, distinguishing numeric `1` from string `"1"`. Close rejects new
sends, aborts blocked delegate writes, closes the delegate, drains the protocol
tail, clears pending dropped ids, and only then tears down child-fault state.

One private cleanup owner serially closes every session resource. An injected
cleanup error occurs before any resource is touched. A failed or partial attempt
retains unresolved ownership, concurrent callers share that attempt, and retry
skips resources already closed. Only complete success freezes the final report.
Reports contain only aggregate listener/transport counts, frozen OAuth record
counts, and safe untriggered fault ids — never raw resource errors or injected
content.

An MCP request can advance an HTTP or protocol occurrence only after one
serialized ingress qualifier proves the exact advertised `/mcp` URL with no query,
POST, JSON content type, a singleton SDK `ClientRequest` or `ClientNotification`,
the scenario era, the 2026 envelope when modern, and standard header/body
agreement. The qualifier uses the pinned SDK's `classifyInboundRequest` and `specTypeSchemas`; it does not maintain a second direction or envelope parser.
Modern JSON-RPC requests require `Mcp-Method`; notifications may omit it but must
agree when present, and `tools/call` also requires decoded `Mcp-Name` agreement.
Bodyless, malformed, batch, posted-response, wrong-route, wrong-verb,
wrong-direction, unsupported, and header-disagreeing traffic reaches the ordinary
SDK rejection path without consuming a fault.

Non-OAuth loopback order is host/origin and advertised-authority validation,
qualification and unique correlation reservation, `node/dispatch`, `http/request`,
protocol injection, the real handler, then `http/response`. OAuth loopback uses
the same outer transport stages and defers MCP protocol injection until after
bearer authentication. Occurrences are independent per exact phase/method.
Ingress-stage coordinates are assigned in ingress order; `http/response` is
assigned in response-completion order. Delay is the only non-terminal HTTP fault;
status, malformed JSON, and drop stop later coordinates, and response-stage replacements cancel the displaced body before returning or throwing.

OAuth authorization faults run inside route-owned hooks after complete route,
body, client, redirect, resource, state, PKCE, and capacity validation but before
client/code/token mutation. MCP operation faults run only after bearer authentication and bounded body preparation.
Thus a valid unauthenticated MCP request may consume an outer transport fault but
never an operation fault. In-process drop rejects `endpoint.fetch`; loopback drop destroys the socket before status bytes are written and leaves the listener usable. Handler diagnostics are capped at 64 per session and contain only a safe correlation, fault id, and fixed message. Session close waits for active fault delays before closing owned handlers and listeners.

Evidence: `assistant-providers/mcp-content-port.md`,
`assistant-providers/mcp-oauth-loopback.md`.
Guard: `apps/desktop/src/__tests__/main/{mcp-oauth-client-provider.integration,mcp-host-runtime-oauth,mcp-server-actor}.test.ts`,
`apps/desktop/e2e/mcp-packaged-core.desktop.test.ts` (the packaged relaunch
proof), and `packages/mcp-test-lab/__tests__/package-contract.test.ts`, which
pins this section's wording verbatim.

---

## ASSISTANT SEARCH TOOLS

The assistant's search verbs, in the order the default instructions present them:

1. `brainstrike.grepSearch` — FIRST for exact strings, identifiers and error
   messages. Two-phase: a trigram-indexed prefilter plus an authoritative JS line
   matcher. Truncation semantics are identical in both output modes, and the hint
   builders MUST emit guidance whenever any of
   `truncated`/`scanLimited`/`candidatesTruncated` is set — the model projection
   fails the run on a limited result without a hint. `scanLimited` reports true
   only when an unfiltered scan hit its candidate cap; over-reporting is as wrong
   as silence. Default `outputMode: 'files'` is the cheap survey, `'content'`
   returns line matches, and both page by `offset`.
2. `brainstrike.queryEmbeddingSpace` — semantic search when exact wording is unknown.
   Semantic/hybrid embedding requests propagate tool aborts as failures, never empty results.
3. `brainstrike.hybridSearch` — vector + full-text RRF fusion reusing the SAME
   `HybridSearchService` as the UI, with `queryEmbeddingSpace`'s explicit-input
   scoping semantics (it does not inherit the implicit UI selection and takes no
   `selectionSnapshotId`). NO SILENT FALLBACK: a failing keyword arm fails the
   call visibly, never degrades to vector-only.
4. The same fusion backs UI search paths; the lexical arm matches with PostgreSQL
   FTS and orders with the pg_textsearch BM25 index plus an `id` tiebreaker. BM25
   orders but never matches — see `docs/agents/database.md`.
5. The web retrieval pair, external via Tavily: `brainstrike.webSearch`
   (provider-native search swapped in on Anthropic/OpenAI for fresh allowed
   turns) and `brainstrike.webExtract` (up to 5 PUBLIC pages as markdown, with NO
   provider-native swap — it must stay Tavily-backed). Both are keyless-HONEST
   (`available:false` plus an actionable message, never a throw) and non-fatal on
   network errors.

- `webExtract` validates every model-supplied URL BEFORE anything is sent
  (http/https only, no embedded credentials, no private/loopback/link-local
  hosts) and reports every refusal per-URL in `failed` — never a silent drop.
  Public hostnames are deliberately not DNS-resolved locally, since the fetch
  runs on Tavily's servers. It never clips a page or asks the model to re-fetch a
  changed source; oversized results use the central artifact settlement path, and
  without durable settlement an oversized result surfaces an explicit
  model-output-unavailable state while its raw result stays intact.
- Approval resume is the deliberate exception to the provider-native swap, only
  when Mastra's durable snapshot identifies the resumed tool as `webSearch`:
  replacing it with the provider-native definition would orphan the durable
  function invocation.
- Grep's zero-match probes run up to three bounded count-only probes in order
  (case-insensitive, literal, then excluded/ignored paths). The first hit becomes
  `probeNote`; all-miss is silent. Probe failure or timeout never fails the tool,
  and the probe's short budget over policy-EXCLUDED trees makes a timeout an
  expected bounded outcome rendered as "probe did not finish", never a silent
  zero.
- The live rg prefilter prunes EVERY directory the balanced policy hard-excludes
  by name plus the shared nested-path prefixes, and `resolveCandidate` re-applies
  the same policy, so the rg candidate set stays a strict SUPERSET of policy-kept
  files. rg exit code 2 WITH usable stdout keeps its candidates and surfaces
  `partialReadErrors`; exit 2 with empty stdout falls back to the walk. Failures
  reject with `RipgrepRunError` carrying pattern-free, non-sensitive metadata, and
  `timedOut` derives from the SIGTERM kill signal plus elapsed-vs-budget, never
  from `killed` alone.
- **`filePaths` scope contract.** ONE resolver
  (`apps/desktop/src/assistant-server/grep-file-paths.ts`) interprets the
  allowlist and BOTH passes consume its output; do not normalize paths anywhere
  else. Workspace-relative entries pass through normalized and pin no root;
  absolute entries inside exactly one open folder resolve to root-relative AND
  carry that folder's `rootId`. Reject — never coerce to an empty result — a path
  outside every open folder, `..` traversal escaping a root, a path inside more
  than one open folder, an absolute path with no folder open, the open folder
  itself, a blank entry, and Windows UNC/drive-relative shapes. `filePaths: []`
  means "nothing allowed" in both passes; `undefined` is the only spelling of "no
  filter".
- Vector search adaptive routing: `searchSimilar` in ALL THREE chunk repositories
  routes NARROWED searches (any filter beyond `embedding_set_id`) through bounded
  selectivity counts, and a filter matching ≤20k rows AND ≤15% of its set
  bypasses the partial halfvec HNSW index with an exact full-precision scan.
  Un-narrowed searches never run the counts. Do not "optimize" selective filtered
  searches back onto the ANN index without re-running the benchmark.

Tool output budget contract:

- Budgets are token-denominated at 4 chars/token. The two default budgets resolve
  once per Mastra run from the active model context window; explicit per-tool
  overrides remain fixed and authoritative.
- Purpose-built domain projections use decoded text length for their self-fit
  contract; the generic/default path and the `boundToolOutputForModel` transport
  guard measure serialized JSON characters.
  `MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET` is the 6000-character 128k anchor
  definition, not a universal per-run value.
- Domain projectors MUST self-fit a complete page; central code throws on
  overflow rather than prefix-truncating a page whose continuation it cannot
  understand. Only generated/default projections may use the generic truncation
  path. The generic model-result ceiling is 8000 characters
  (`MAX_MODEL_TOOL_RESULT_TOKENS` 2000); the domain tier is
  `MAX_DOMAIN_MODEL_TOOL_RESULT_TOKENS` 1500 / 6000 characters.
- Self-bounding native tools that rely on the generic projection are enumerated
  in `MODEL_PROJECTION_BUDGET_OVERRIDES` with the wider `NATIVE_SELF_BOUND_*`
  envelope, so their own head+tail retention and truncation hints pass through
  unmodified. `NATIVE_TOOL_RESULT_TOKEN_BUDGET` is 2750 and
  `SKILL_ACTIVATION_RESULT_TOKEN_BUDGET` is 6000.
- **Projector throws are two different contracts.** A projector's
  SHAPE-VALIDATION path — "this value is not my tool's result at all" — throws
  `ToolProjectionInputRejectedError`, and the dispatcher degrades ONLY that
  marker to the generic bounded projection, logging
  `tool_model_projection_fail_soft` with a keys-only shape summary. Every OTHER
  projector throw is deliberate contract enforcement and still fails the run.
  When adding a projector, choose per throw site.
- Mastra's tool-input/output validation failure carrier never reaches domain
  projectors: the dispatcher routes it to the generic bounded projection
  alongside guarded tool errors. It is an EXPECTED shape for a mis-parameterized
  call, so it must not burn an error-severity fail-soft log.
- A continuation handle is a 26-character random `nextCursor` resuming at the
  exact source line and column. The authoritative root id, path, range, byte
  size, mtime and source position stay in the main-process registry and are never
  echoed through the model. Handles bind to the originating thread, expire after
  one hour, survive renderer reload, and are cleared by factory reset. A handle
  releases only after its continuation page has been validated and built, so
  failed reads stay retryable. Malformed, unknown, expired, released,
  cross-thread, cross-root and stale-file continuations fail visibly — there is
  no legacy-cursor decode or fresh-read fallback.
- Desktop reads each page from one containment-checked file handle, statted
  before and after, binary-probed, and decoded as fatal UTF-8 in 64 KiB chunks.
  It still scans to EOF because `totalLines` and `omittedChars` are exact public
  metadata, never estimates.

Evidence: `assistant-providers/grep-search-passes.md`,
`assistant-providers/search-verbs-and-routing.md`,
`assistant-providers/tool-output-budgets.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/live-grep-ripgrep-failure.integration.test.ts`,
`web-extract-tool.test.ts`, `web-extract-model-projection.test.ts`,
`packages/db/__tests__/search-hybrid-eval.test.ts`,
`packages/agent/src/__tests__/{tool-model-output,tool-output-limits}.spec.ts`.

### Context-window-scaled default budgets

- `createMastraAgentRuntime` resolves the active model once via
  `resolveToolResultBudgetForModel`, which reads the catalog `contextWindow`
  through the non-throwing `findLlmModelDefinition`. **A budget default is NEVER
  a hard precondition for starting a run**: the static registry is a curated
  subset, so a budget lookup failing must not kill a run.
- Runtime-discovered Ollama and LM Studio ids use
  `DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW` (32,768). Every other unknown
  provider/model id falls back to the 131,072-token ANCHOR with a visible
  `tool_result_budget_unknown_model_fallback` warn — the documented default,
  logged. A registered entry with an invalid `contextWindow` still throws.
- The anchor is 131,072 context tokens. Domain is
  `round(1500 * contextWindow / 131072)` clamped to 500..3000 tokens; transport is
  `round(3000 * contextWindow / 131072)` clamped to 1000..6000. A 128k model
  therefore retains byte-identical 1500/3000 behavior.
- Domain-level per-tool entries in `MODEL_PROJECTION_BUDGET_OVERRIDES` stay fixed
  and unscaled at every tier — they key off their own dedicated constants.
  Transport-level entries in `TOOL_RESULT_TOKEN_BUDGET_OVERRIDES` scale WITH the
  resolved transport budget, but only DOWN: at or above the anchor an override
  wins unchanged, below it an override scales by the same factor as the generic
  default, floored at the generic 1000-token transport floor.
- **Replay validation is deliberately asymmetric.** A fresh projection uses the
  current run's resolved default; a stored projection may have come from a
  larger-window run, so replay validates the default domain portion against the
  fixed ceiling tier (3000 tokens / 12000 characters). The total model envelope
  and every domain-level override are unchanged at every tier on both paths, and
  replay's newly-composed hook context is fitted against the same fixed
  8000-character ceiling either way — a known, documented tradeoff; see
  `docs/agents/assistant-runtime.md`'s replay section.
- The file-read staleness tracker updates only after cursor validation and page
  construction succeed inside the per-file lock.
- Guarded failures (`tool_timeout`, `tool_failed`, `tool_input_invalid`,
  `tool_blocked_by_hook`) bypass domain projectors and retain the bounded
  structured failure; trusted `ToolInputError` validation failures preserve their
  safe, model-correctable message.
- Multi-root resolution uses that path when a root-qualified tool misnames or
  ambiguously names `root`. An omitted selector uses `boundWorkspaceRootId` only
  when request preparation has durably bound the thread to a live DB root;
  without that binding, ordinary single-target tools retain the visible ambiguity
  error. A stale binding returns `bound_workspace_root_unavailable` HTTP 409 and
  never falls back to Main. Correctable errors list complete
  `displayName (id rootId)` choices within an 800-character budget and otherwise
  direct the model to `listWorkspaceContext` rather than truncating an identifier.
- The desktop LSP pool is keyed by the durable database `roots.id`, never the
  renderer adapter id — those identities can diverge after remove/re-add.
- Successful hooked results travel in the explicitly discriminated internal
  `HOOK_RESULT_ENVELOPE_FIELD` protocol. The envelope is removed and the exact
  domain result restored before either a custom or default projector runs, and
  Brainstrike's PGlite store enforces the transcript projection at its write
  boundary. A nullish custom projection falls through to the bounded default;
  malformed non-callable projections throw.
- Brainstrike's projection contract is Mastra's documented CoreTool
  `toModelOutput(output)` callback, where `output` is the raw execute result. Do
  not reinterpret a public `{toolCallId,input,output}` object by shape — those
  keys are valid domain data. Any future standalone AI SDK adapter must be a
  separately named boundary with an explicit input type.
- `ProjectionAwareTokenLimiter` substitutes the stored
  `providerMetadata.mastra.modelOutput` (inline media replaced by counting
  markers), delegates to Mastra's limiter, and restores the exact raw result in a
  `finally`. Keep its canonical processor id `token-limiter`.
- Runtime token measurement is observational and MUST NOT replace those safety
  limits. `provider-registry.ts` resolves one explicit capability per exact
  provider/model tuple: `exact-selected-model`, `declared-compatible-reference`,
  or `deterministic-serialized-character-backstop`. Never infer a tokenizer from
  a model-name substring. `@brainstrike/tokenization` is the single
  implementation owner; `text-splitter`, `utils` and worker packages carry no
  re-export facades or local copies.
- One `mastra_agent_token_measurement` structured log carries counts and bounded
  failure metadata only — never raw prompts, tool schemas, results, credentials
  or user content. Counter failure retains the declared mode, keeps the
  deterministic backstop totals and logs at warning level; it never disables the
  independent safety envelope.
- MCP text/JSON uses a separate temporary inline ceiling only when the host
  supplies no durable artifact settlement, bounded to the run's resolved
  transport default (`MAX_TOOL_RESULT_TOKENS` 3000 is the 128k anchor; the
  resolved range is 1000..6000). Multimodal output always stays inline so the
  display/transcript channels can render it, and durable settlement never
  converts media arrays into text artifacts. Exceeding a ceiling throws visibly —
  never drops media.
- Artifact ids and cursors accept only bounded opaque tokens — never filesystem
  paths, URLs, thread ids or storage locations. Preview and page fields are
  capped at 8000 UTF-8 bytes both after outer JSON serialization and decoded.
  Page guards require a continuation cursor exactly when bytes remain and reject
  gaps, overlaps, extra fields, unsupported encodings and malformed versions
  instead of guessing. Exact replay of one scoped tool call is idempotent only
  when format and complete bytes match.
- Desktop injects the settlement store only for a server-owned run with resource,
  thread and run scope, and registers `brainstrike.readToolOutputArtifact` only
  when that scoped capability exists; web omits it rather than stubbing it. After
  settlement, `toModelOutput` bypasses the original domain projector and projects
  a bounded initial-page view exposing one exact reader/cursor action.
- The UI transport independently applies the generic transport backstop. Callers
  inside an active run use the resolved default; the context-free data-stream
  mapper retains the 3000-token anchor because its replay boundary has no
  active-model carrier. Oversized collections are structurally trimmed; opaque
  outputs become a SUCCESSFUL `tool_result_truncated` preview with an actionable
  hint, retaining a balanced 50/50 head and tail around an explicit
  omitted-character marker with both cut points snapped away from surrogate-pair
  interiors.

Purpose-built projections:

- `grepSearch`, `globWorkspace`, `readWorkspaceFile`, `executeCommand`,
  `findWorkspaceSymbol`, `lspInspect`, `listWorkspaceContext`,
  `queryEmbeddingSpace`, `hybridSearch`, `webSearch` and
  `readToolOutputArtifact` keep their complete typed raw results for display,
  persistence, hooks and reload, while their Mastra `toModelOutput` projections
  are deterministic line-oriented text fitting the domain budget.
- Content mode returns NO context lines unless the caller opts in
  (`contextLines` defaults to 0 — searches locate, reads understand). The
  inspector display derives from the schema, so there is no second mirror.
- Projections are PATH-GROUPED and happy-path-silent: one file header per file,
  root prefix only when the producer's `openRoots` reports more than one open
  folder. Engine/limit flags appear in the header ONLY when they fire; the read
  recipe lives once in the tool descriptions.
- Because Mastra's one-argument projector receives the raw result but not the
  original input, paging guidance tells the model to reuse the prior call; it
  never fabricates the original pattern. When the whole raw page fits, preserve
  the producer's bounded hint. Producer guidance includes an `offset` only when
  it strictly advances; otherwise give terminal query-refinement guidance. **A
  truncated result without producer guidance throws instead of guessing.**
- Paths and root labels are NEVER clipped or whitespace-collapsed — a mangled
  selector is unusable; a pathological selector overflows the budget and its item
  is omitted with an advancing offset. Root-name ambiguity is decided by the
  PRODUCER against the full open-root inventory, never page-locally.
- SETTLED filename-forgery ruling: line breaks and a leading whitespace character
  in paths are escaped, so a hostile filename can never create a new projection
  line nor mimic an indented match row. A filename that merely resembles a header
  is an accepted residual — do not reintroduce per-row quoting to chase it.
- Stored text projections replay byte-for-byte on a later same-run step rather
  than being reparsed as raw results. Legacy stored JSON projections are unwrapped
  and re-rendered; legacy raw results without topology fields degrade to an
  unprefixed header without losing content.
- An authoritatively resolved zero-root Desktop workspace is a SUCCESSFUL compact
  result with `workspaceRoots: []` and an explicit `roots=0` line; an absent or
  malformed root-resolution result still fails visibly.
- Provider-native Anthropic/OpenAI web search is owned by the provider adapter
  and does not pass through the execute-backed Tavily projector.

Native-tool catalog ownership — ONE `defineNativeTool` declaration per tool,
everything else derived:

- `packages/assistant-contract/src/native-tools/definitions/*.ts` holds one file
  per tool, `native-tools/index.ts` is the ONLY list (`NATIVE_TOOLS`), and
  `deriveNativeToolRegistries` produces every registry from it under its
  historical export name. `defineNativeTool` throws on an undeterminable risk
  bucket, a deferred tool without a namespace, or a critical tool with one.
- `NATIVE_TOOL_SCHEMAS` is DERIVED from each definition's `inputSchema` by
  `native-tools/display.ts` using the same conversion the provider wrapper runs,
  so parameter names, types, required-ness, enum options, defaults and bounds
  cannot drift from the wire. A parameter's prose is its `.describe()` text; a
  `display` map adds inspector-only prose and throws on a key naming no
  parameter. **`NATIVE_TOOL_SCHEMAS` is NEVER an execution or provider-schema
  source.**
- `packages/agent/src/tools/schemas.ts` exports `NATIVE_TOOL_INPUT_SCHEMAS`
  derived from the desktop definitions' `inputSchema` objects; the Zod modules
  live in `packages/assistant-contract/src/native-tools/schemas/` — edit the
  contract package, never the agent shims. Mastra converts them through the
  Standard Schema input protocol; never reconstruct validation or provider
  schemas from the lossy display metadata.
- Agent Skills are `kind: 'skill'` definitions and are not entries in
  `NATIVE_TOOL_INPUT_SCHEMAS`; the desktop-only `brainstrike.runSkillScript` is a
  Brainstrike-owned typed execution tool and IS in the desktop catalog.
- **Provider-emitted `null` has one fleet-wide meaning: omission, never a second
  domain value.** `providerCompatibleInputSchema` wraps each registered input
  once and removes `null` only from declared properties absent from `required`.
  Dynamic record values and ambiguous union branches are not omittable; authored
  intersections and structured record values are unsupported traversal shapes
  reported with the tool id plus JSON path. Required fields still reject `null`,
  and invalid non-null values still fail their original validators.
- An optional/defaulted catalog field must not use `null` as a meaningful
  third-state such as "clear this value" — model that with an explicit action or
  discriminator. Because provider `null` reaches the same path as omission,
  omitted/default behavior must also be the least-capability behavior.
- Server-owned MCP schemas keep their own omission semantics. The MCP adapter
  explicitly sets `strict: false` unless the server opts in through
  `_meta.mastra.strict`, because an omitted strict flag lets OpenAI Responses
  normalize optional fields into required ones. Do not repair that by stripping
  zero, null or empty arguments — they may be meaningful server inputs.
- Adding or renaming a native tool is one `defineNativeTool` file plus one entry
  in the desktop executor map; a definition with no entry, or an entry with no
  definition, is a compile error. The catalog's inline snapshot is the only
  hand-listed id set, so there is no stale, missing or extra key to drift — and
  no fallback alias or partially registered tool.

Desktop-only native tools:

- `brainstrike.manageCanvas` is desktop-only because its source of truth is the
  client-local `brainstrike_canvas_versions` ledger; web has no remote fallback.
  It is a deferred workspace tool with an `action` discriminated union and
  explicit `edit` risk, because create/update/rewrite persist durable state.
- Settled ruling (do not relitigate): the union branches TOLERATE cross-action
  extras among the six declared envelope keys — `action` fully determines
  semantics, and rejecting bundled fields broke the feature. Only genuinely
  unknown keys fail, at the strict provider envelope.
- Settled, CREATE REQUIRES CONTENT (do not relitigate): `create` refuses a
  document `isEmptyCanvasDocument` judges empty, BEFORE any DB call and at no
  approval cost, with the structured `empty_document` failure and
  `EMPTY_CANVAS_DOCUMENT_HINT`. `update`/`rewrite`/`list` are unchanged. The
  description and the conditional instruction both say the write IS the
  deliverable and never an empty placeholder.
- **The canvas storage ceiling is `CANVAS_HTML_MAX_BYTES` (8 MB), counted in
  UTF-8 BYTES.** Two places enforce it from one constant: the `manageCanvas`
  input schema bounds each incoming HTML field (which also puts `maxLength` in
  front of the model), and `insertVersion` in the desktop canvas repository
  bounds what reaches the text column, returning `too_large`. Both halves are
  load-bearing — `update` composes a document larger than either field it was
  handed.
- `.max()` alone is not a byte bound: Zod counts code points, so
  `.max(8_000_000)` admits 31 MB of UTF-8. The `minLength` on `oldString` is
  applied before the byte refinement, because a refinement is not representable
  in JSON Schema. A row written before the ceiling existed can sit above it and is
  update-locked except for an update that brings it under in one shot; `rewrite`
  is the deterministic way out, which is why the hint names it.
- `brainstrike.queryDiagnostics` is desktop-only and explicit `read` risk, with a
  required `mode`. The schema hard-caps `limit` at 200, the repository applies
  the same bound, and the producer self-bounds through `fitItemsToCharBudget`;
  hitting either cap is reported in `truncated` plus an actionable `hint` — never
  presented as a complete result.
- `brainstrike.listWorktrees` and `brainstrike.manageWorktree` are desktop-only
  for the same reason. They collapsed to two ids on the RISK split, not on merged
  capability: `listWorktrees` is `read`-risk with no approval so plan-mode
  orientation works, while `manageWorktree` is `execute`-risk with
  `requiresApproval: true` and a `create | archive` union. Both share ONE
  `workspace` discovery namespace entry.

Evidence: `assistant-providers/scaled-budget-resolution.md`,
`assistant-providers/multi-root-tool-resolution.md`,
`assistant-providers/hook-envelope-and-projection.md`,
`assistant-providers/tool-output-artifacts.md`,
`assistant-providers/projection-formats.md`,
`assistant-providers/native-tool-catalog.md`,
`assistant-providers/desktop-only-native-tools.md`.
Guard: `packages/assistant-service/src/__tests__/stream-init-tool-budget.test.ts`
(parity between the two resolutions),
`packages/agent/src/__tests__/{tool-model-output,tool-output-limits,projection-aware-token-limiter,token-measurement,mcp-optional-inputs,mcp-runtime-client}.spec.ts`,
`mastra-tool-execution.integration.spec.ts`,
`mastra-memory-persistence.integration.spec.ts`, `data-stream-session.spec.ts`,
`packages/assistant-contract/src/__tests__/native-tools.test.ts`,
`execute-command-model-projection.test.ts`,
`execute-command-tool.integration.test.ts`, `canvas-document-content.test.ts`,
`manage-canvas-tool.test.ts`, `canvas-html-byte-ceiling.test.ts`,
`canvas-repository.test.ts`.

### MCP discovery skip reporting

- `collectCombinedTools` returns `{ mcpDiscoverySkips, tools }`. A skip is DATA;
  the loader never decides how loudly it is reported. Every skip logs at `warn`,
  unconditionally, and the reason string is never inspected.
- Two scopes, one row per ACTUAL failure. `scope: 'client'` means the whole
  listing rejected or lost the timeout race — ONE skip naming every server.
  `scope: 'server'` is one skip per failing server, filtered to the run's own
  `namedServers`, because a row claiming a server "was skipped for this request"
  must be true of THIS request.
- `boundMcpDiscoveryReason` REDACTS URL userinfo and query strings, THEN BOUNDS
  the total length to `MAX_MCP_DISCOVERY_REASON_CHARS` (200, ellipsis included),
  slicing by code point. Truncation is not redaction — the redaction is what
  makes a persisted, always-visible row safe.
- `McpDiscoverySkip` is a DISCRIMINATED UNION, not one shape with two optional
  name fields.
- The skips ride `MastraAgentRuntime.mcpDiscoverySkips` — REQUIRED, never
  optional, so an empty array means "discovery was healthy". Only the
  initial-turn seam passes a non-empty `preludeChunks`; approval- and
  suspend-resume legs pass `[]` explicitly.
- **The rows must be yielded INSIDE `runTurnAttempts`, never by a wrapper around
  it.** That generator's `finally` calls `runtime.dispose()` and only runs once
  its body has STARTED, so a wrapper yielding the rows first could be cancelled
  before delegating and leak the runtime, MCP client and abort listeners.
- The run still answers rather than throwing: one flaky server would otherwise
  break every chat turn. The reduced tool surface is reported, not hidden.
- Still open: `DEFAULT_MCP_TIMEOUT_MS` is 5000 and `mcpTimeoutMs` is threaded end
  to end, but no production caller supplies it, so 5s is always the effective
  ceiling including on cold stdio startup.

Evidence: `assistant-providers/mcp-discovery-skips.md`. The durable/timeline half
is in `docs/agents/assistant-persistence.md`.
Guard: `packages/agent/src/mastra/__tests__/mastra-streaming.spec.ts` ("still
disposes the runtime when the consumer stops ON the skip row").

### Settings tools-availability indicator

- `connected` is a TRANSPORT fact — the handshake succeeded, not that
  `tools/list` returned. `resolveMcpToolsAvailability`
  (`packages/settings-ui/src/settings/tools/mcp-tools-availability.ts`) derives
  the distinction from the host snapshot the row already has; it is pure and
  snapshot-only, so it adds no second source of truth.
- **It reports only what it can PROVE.** `tools-unavailable` requires
  `catalog.errors.tools`, a positive settled failure signal an in-flight query
  cannot produce. Everything else is `available`, including a server advertising
  no tools capability at all.
- Do not widen that narrowness without first adding a settled-vs-pending signal
  to the snapshot: "no catalog" and "tools absent" are the NORMAL state of every
  healthy server between handshake and enumeration, and an indicator that cries
  wolf is worth less than no indicator.
- The degraded dot uses the semantic `warning` token, NOT the `yellow-500` that
  already means connecting/authorizing, and carries an `aria-label` and a
  `data-tools-availability` attribute — colour alone is not a signal, and a
  fill-class assertion in E2E is as fragile as the row state it replaces.

Evidence: `assistant-providers/mcp-tools-availability-indicator.md`.

### MCP Settings progressive disclosure

- The server row keeps lifecycle state, available controls, tool-availability
  failures, catalog content, server/control errors, and malformed or unreadable
  credential notices visible. Stdio/client diagnostics stay visible for error and
  authentication-required states; healthy-server logs go inside the disclosure.
- Protocol policy/generation, OAuth facts and effective extension advertisements
  live inside a native `details` disclosure labeled "Connection details". Failure
  diagnostics do not force it open or override the user's DOM-resident open
  state, and expanding it never initiates authorization or a lifecycle control.
- The credential status region stays mounted while its content changes, so later
  faults update an existing live region. Initial faults render visibly; automatic
  initial screen-reader announcement is not promised.
- The disclosure resets on a new server generation; current snapshot facts remain
  the sole authority, available without an additional host call or persistent UI
  store.

Evidence: `assistant-providers/mcp-settings-disclosure.md`.
Guard: `mcp-connection-details.test.tsx` (node identity, both fault wordings,
visibility, recovery controls, local expansion).

### MCP tool-preference persistence

`mcp/tool-preferences.json` under `userData` is the user's only copy of which MCP
tools they turned off. It has TWO writers, and every rule below exists because
one of them destroyed data.

- **Absence is not failure, and is not evidence of staleness.** MCP discovery
  loses its race routinely, so a run that did not see an id is ordinary, not an
  edge case. Neither write path may treat "not in this run's discovery" as
  "gone".

Evidence: `assistant-providers/tool-preference-persistence.md`.
Guard: `apps/desktop/src/__tests__/main/ipc-mcp-preferences.test.ts`,
`packages/agent/src/__tests__/tool-persistence.integration.spec.ts`.

#### Write precedence: read → refuse → merge

`applyToolPreferenceMutation` (`apps/desktop/src/mcp/tool-discovery.ts`) takes a
`ToolPreferenceWriteIntent`:

| Intent | Caller | Reads first | Refuses on `invalid`/`unreadable` | Preserves undiscovered ids |
| --- | --- | --- | --- | --- |
| `merge` | `mcp:tools:enable` / `disable` | yes | **yes** | **yes** |
| `replace` | `mcp:tools:reset` | no | no | no |

- `merge` seeds from the stored file (`enabledTools` first, then `disabledTools`,
  so an id in both lands disabled — re-enabling a tool the user turned off is the
  harmful direction to guess in), then overlays this run's registry. A `merge`
  into an unreadable file throws rather than degrading into a whole-file replace.
- **The save path retires nothing and has no notion of what "retired" means.**
  Retirement is the projection path's job, keyed on a server's removal from the
  MCP config — never on a failed discovery, in either path. Do not add a second
  retirement rule to the save path.
- **The read happens BEFORE the mutation.** A refused write must not leave the
  live registry changed, and the registry snapshot stays synchronous with the
  mutation, so a concurrent re-discovery cannot be folded into the write.
- **The version stamp is a constant, not an echo.** Echoing a newer file's stamp
  would mark v1-shaped data as already migrated.

Evidence: `assistant-providers/tool-preference-write-precedence.md`.

#### Reset is the remediation, so it is never gated

- `mcp:tools:reset` uses `replace`: it preserves nothing by definition, so it
  does not read the file and is not blocked by the latched fault. Reset is the
  ONLY in-app recovery for a corrupt preferences file.
- A successful reset also CLEARS `toolPreferencesFault`, because it has just
  written a readable file.
- Reset discards every stored id, including undiscovered servers'. It is an
  explicit, labelled discard, and a half-reset that silently leaves entries
  behind is both surprising and an unreliable remediation.

Evidence: `assistant-providers/tool-preference-reset.md`.

#### Both writers take one lock

- `withToolPreferencesFileLock` serialises every read-modify-write of the file.
  The two writers are on DIFFERENT queues and genuinely interleave, and
  `latestAuthorityEpoch` narrows the window but cannot close it — that check runs
  once at operation entry, before the I/O.
- Any new writer of this file MUST take the same lock.

Evidence: `assistant-providers/tool-preference-lock.md`.

### Tool discovery contract (LIVE for hosted Mastra catalog search)

- `packages/assistant-contract/src/tool-discovery.ts` is the authoritative
  adapter and loading-tier contract. `createMastraAgentRuntime` selects
  `mastra-catalog-search` explicitly for hosted routes, constructs the Agent from
  the post-gate critical/custom surface, and gives only the post-gate deferred
  surface to `BrainstrikeToolSearchProcessor` (the fail-loud wrapper around
  Mastra's `ToolSearchProcessor`). Built-in/local runtime behavior is unchanged.
- The canonical native metadata has one exact eight-tool `critical` set:
  `askUser`, `executeCommand`, `globWorkspace`, `grepSearch`,
  `readWorkspaceFile`, `stringReplaceWorkspaceFile`, `submitPlan` and
  `writeWorkspaceFile`. Keeping one approval-gated create primitive critical is
  deliberate. Every other native tool is `deferred` and belongs to exactly one
  namespace in `NATIVE_TOOL_DISCOVERY_NAMESPACES`.
- **Loading tier is not authorization.** `resolveToolDiscoveryPhaseAccess` keeps
  disabled, permission-denied and host-unavailable tools out of search, load and
  active phases. An `ask` permission stays searchable and loadable, but the
  downstream permission gate must still suspend before execution. Runtime
  partitioning happens only after guards, hooks, plan mode, permission,
  approval-storage, provider web-search, artifact settlement and model-output
  projection; it cannot restore a tool an earlier stage omitted.
- Unknown caller-supplied local tools, provider-defined web search, Mastra's
  `skill`/`skill_read`/`skill_search` controls and the eligible
  `readToolOutputArtifact` recovery control stay EAGER — deferring them would
  make injected instructions or settlement actions reference unavailable tools.
- `LlmModelDefinition.nativeToolSearch` records provider-native support on the
  exact model ROUTE; OpenRouter aliases do not inherit the capability.
  `resolveToolDiscoveryAdapter` never substitutes another strategy when a caller
  requests an unsupported adapter, and its unsupported result retains a typed
  reason. OpenAI's native `tool_search` is model-gated, not inferred from
  `provider === "openai"`.
- Live catalog search uses `storage: 'context'` and
  `search: { autoLoad: false, topK: 3 }` — manual loading. `search_tools` is
  discovery only: at most three ranked matches, loading nothing. `load_tool` is
  Mastra's canonical exact-name selection. Every discovery step offers, in this
  key order: `search_tools`, `load_tool`, the loaded deferred tools, then
  `list_available_tools`.
- **Do not re-enable `search.autoLoad: true`**: that mode withholds `load_tool`,
  and the earlier workaround — a pnpm patch splicing exact-name selection into
  `search_tools`' BM25 path — was a misuse of the search control, not a missing
  upstream feature. That patch is deleted; do not add another for discovery. (The
  repo does still carry unrelated patches for proven upstream defects.)
- Search results are ranked selections, never an inventory.
  `list_available_tools` exposes the same post-gate, per-runtime deferred catalog
  without loading definitions or executing MCP requests: case-insensitive name
  prefixes, pages of 50, the matching total and `nextOffset` (null only at the
  end), and descriptions explicitly marked as shortened to 160 code points.
  Ordering uses code-unit name comparison, not the host locale; each
  prefix/offset query is independent; inventory results never enter Mastra's
  loaded-tool state.
- **THE DISCOVERY SURFACES NAME EVERY ELIGIBLE DEFERRED FAMILY — AND ONLY
  ELIGIBLE ONES.** A deferred capability the prompt never names is a tool the
  model declares nonexistent instead of searching for; advertising a family the
  run cannot load is the opposite failure. Both surfaces — the instructions'
  discovery line AND `search_tools`' own description — DERIVE their family list
  per run from `deferred-capability-families.ts`, the single source. The line
  also states that a tool named by the instructions or a skill activation but not
  loaded is reachable via `load_tool` by exact name.
- **"NEXT TURN" MEANS THE NEXT MODEL STEP OF THE SAME RESPONSE — say so
  explicitly.** Every Brainstrike-owned surface says "callable on your next step
  in this same response" and forbids ending the reply to wait: the instructions'
  discovery line, `describeSearchMatches`, the skill execution guidance, and
  `wrapLoadTool`'s rewrite of Mastra's `load_tool` success sentence — leaving its
  failure copy verbatim, since there is nothing to call.
- **THE BATCHING EXEMPTION LIVES ON THE BATCHING LINE — do not relitigate.** A
  loaded tool is callable only on the FOLLOWING model step, so
  `buildParallelCallInstruction` carries the exemption, conditional on discovery
  being installed. Stated once: repeating it on the discovery line spends prompt
  budget saying the same thing.
- Discovery observability is content-minimizing by default: production logs may
  record query length plus the original ranked tool ids and finite scores, never
  the raw query, tool schemas or credentials. The exact query reaches only an
  explicit in-memory observer used by the opt-in live evaluation.
- The telemetry wrapper clones Mastra's `search_tools` value with its original
  prototype and complete own-property descriptors, then replaces only the
  description and executor on that clone. It never mutates or wraps the
  Mastra-owned value in place.
- Mastra owns the fixed `search_tools` and `load_tool` ids; Brainstrike owns
  `list_available_tools`. A surviving definition whose canonical sanitized form
  is any of the three reserved ids throws `mastra_agent_tool_name_collision`
  before constructing the Agent, reporting only the original, sanitized and
  reserved ids. Never rename the collision, disable discovery, or widen the eager
  surface silently; `MASTRA_CATALOG_META_TOOL_IDS` is the single list.
- Persisted `load_tool` results reconstruct loaded definitions after restart, and
  approval/suspended-tool resume rehydrates them from the durable Mastra thread
  before the paused call reaches execution. A loaded-set shrink within one
  runtime/thread throws `mastra_agent_tool_discovery_failure` instead of silently
  de-loading. `TOOL_DISCOVERY_FAILURE_CODES` pins `catalog-miss`,
  `permission-denied`, `host-unavailable` and `unsupported-adapter`; adapters
  must not collapse them into an empty result.
- The live assembly order is pinned by `TOOL_DISCOVERY_PIPELINE_ORDER`:
  capability/permission eligibility → guards/hooks → plan/permission/suspend
  gates → provider-native web-search swap → output settlement/projection →
  skills metadata → discovery → projection-safe stale-history filtering →
  provider-history compatibility → projection-aware token limiting. Initial,
  approval-resume and suspend-resume calls all use the same per-runtime
  processors, token limiting stays last, and public direct stream processor
  overrides stay rejected.

Evidence: `assistant-providers/tool-discovery-tiers.md`,
`assistant-providers/tool-discovery-inventory.md`,
`assistant-providers/tool-discovery-next-step.md`.
Guard: the `tool-discovery capability coverage` spec,
`default-instructions.spec.ts`, `tool-search-runtime.spec.ts`,
`skill-tools.spec.ts`, the namespace parity tests (every canonical native id in
exactly one partition, no namespace over nine functions), and the opt-in
`tool-discovery-live-eval.integration.spec.ts`.

#### Provider-native decisions

- Provider-native support is declarative, not live. The measured decision remains
  `mastra-catalog-search` for every hosted production route.
- There is no fallback between discovery adapters. A future provider-native slice
  must be selected explicitly and independently prove provider-history
  serialization, normal-prompt selection/miss quality, post-policy catalog
  admission, MCP/provider-web coexistence, approval suspension, durable restart
  resume, cache behavior, and non-inferior token/cost measurements.
- Do not trade the measured quality floor for a smaller unsuccessful request or a
  one-turn improvement that needs answer-specific prompting.

Settled: OpenAI native search cleared its duplicate-item blocker but failed the
paired economic gate (69–117% more input tokens, 36–79% more estimated cost).
Evidence: `assistant-providers/provider-native-tool-search.md`,
`docs/agents/research/bst-614-native-tool-search-spike.md`,
`docs/agents/research/bst-680-openai-native-tool-search-requalification.md`.

#### Programmatic orchestration decision

- Do not add a production programmatic-orchestration mode yet. The no-go stands
  on the measured correctness result, which a dependency bump cannot move;
  adoption requires a fresh measured re-run against the recorded gates.
- Do not add casts or a raw parallel Responses loop around Mastra's
  provider-history, persistence, suspension, telemetry and processor contracts.
  There is no silent route switch.
- If the gates ever clear, the exact program-visible candidate allowlist is
  `readWorkspaceFile`, `readWorkspaceDirectory`, `globWorkspace`, `grepSearch`
  and `findWorkspaceSymbol`, intersected after capability, user-enabled and
  permission admission. Everything else stays direct.

Prompt budgets for the full hosted desktop tool surface:

- `apps/desktop/src/__tests__/assistant-server/native-tool-prompt-budget.test.ts`
  builds the real registry and resolved hosted instructions with the default
  skills engine enabled. The canonical authored representation converts the real
  Zod inputs through the Standard Schema input protocol and must stay INSIDE the
  10,096–10,396 `o200k_base` band: the ceiling bounds growth, the floor detects a
  tool or schema silently falling out of the registry.
- When the ceiling fires, TRIM BEFORE RAISING. Move both bounds together — the
  ~300-token width is the contract — and record the trade in the test's comment
  ledger. Do not weaken validation constraints, spoof provider/model identity, or
  remove cross-tool safety invariants to make either number pass.
- The live actual Mastra/OpenRouter core surface and resolved instructions must
  stay between 2,000 and 5,000 tokens. The authored eager baseline of 39 tools
  sits in its 9,340–9,640 band and the 8-tool critical definition surface in its
  2,016–2,316 band, before discovery controls are added.
- Both count schemas AND instructions for their declared surfaces, not
  descriptions alone. The core envelope excludes processor-added discovery
  controls, so the core ceiling must not be presented as a cap on the full
  request. Tokenizer counts are not provider-billed usage or a cache-discount
  estimate. Recover budget by removing duplicated prose and preserving one
  canonical definition.
- Persistent commands use two deferred model tools, not six operation-specific
  definitions: `inspectCommandSessions` owns read-risk list/read,
  `manageCommandSession` owns execute-risk start/write/stop/remove. Each schema
  is a provider-compatible ROOT OBJECT containing a nested discriminated
  `operation` union. A single mixed-risk tool is forbidden, and top-level schema
  unions are forbidden because hosted providers require a root object. Plan mode
  keeps inspection and omits management, and their canonical ids are explicitly
  excluded from durable artifact settlement.
- Target-aware transcript transforms retain safe action, session, cursor and
  length metadata but redact command strings, cwd, stdin, input deltas, PTY
  output and guarded error messages before persistence. The built-in local
  provider gets neither definition; Web uses `WEB_NATIVE_TOOL_IDS` and exposes
  neither.
- The desktop Terminal surface exposes those sessions through the
  capability-gated `window.commandSessions` bridge. Every operation includes the
  durable workspace root id, and the manager rejects a session owned by another
  root with the same not-found error. Reads page at 32,768 UTF-16 code units with
  an advancing absolute cursor and never split a surrogate pair; IPC retains a
  fail-loud 32,768-unit assertion rather than silently trimming. This bridge adds
  no second process registry and does not exist on Web.

Evidence: `assistant-providers/programmatic-orchestration.md`,
`assistant-providers/tool-surface-prompt-budget.md`,
`assistant-providers/command-session-tools.md`,
`docs/agents/research/bst-616-programmatic-orchestration-spike.md`.
