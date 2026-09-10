# Assistant Providers, MCP Transports, Native Tools

> Extracted from AGENTS.md (2026-07-12). Read before changing provider config, MCP transport selection, or assistant native tools/registries. Keep updated with the code.

## AI ASSISTANT INTEGRATION

- Supports hosted providers OpenAI, Anthropic, Google, and OpenRouter, plus the
  Ollama and LM Studio local servers.
- Ollama and LM Studio chat use Mastra's first-class OpenAI-compatible model
  config (`{ id: "provider/model", url, apiKey }`). The configured origin is
  normalized to a `/v1` base URL and Mastra owns the chat-completions adapter.
  Do not route these providers through `@ai-sdk/openai`: its default callable
  selects OpenAI's provider-specific Responses model instead of Mastra's
  generic compatible-provider path. Brainstrike passes an explicit dummy key
  when local auth is disabled so `OPENAI_API_KEY` is never inherited and sent
  to a local or LAN server. Optional runtime tokens still come from the desktop
  secrets bridge. The `providerOptions.ollama` and `.lmstudio` namespaces are
  Brainstrike transport configuration, not generation options; strip both at
  every Mastra stream/resume boundary so `baseUrl` and `apiToken` can never be
  serialized into a chat request body.
- **Local-runtime HTTP goes through `fetchJsonWithTimeout`, and its `fetchImpl`
  MUST NOT be invoked as a property of the options bag.** `options.fetchImpl(...)`
  makes `this` the options object, and the browser's native `fetch` rejects any
  receiver that is not the global object with
  `Failed to execute 'fetch' on 'Window': Illegal invocation` — the request
  never leaves the browser, so a probe fails identically whether or not a daemon
  is listening. That shipped once (BST-964): Ollama and LM Studio reported
  `Unavailable` even while running. Read the impl into a local first, and bind
  the ambient default at capture (`globalThis.fetch?.bind(globalThis)`) in
  `LocalRuntimeDiscoveryService` and `LocalRuntimeModelCatalogService`.
  Measured: a BARE call on an unbound reference is fine (`this` is `undefined`
  and the engine tolerates it) — only a PROPERTY call breaks, which is why the
  bare-call `fetch` captures elsewhere in the repo are unaffected.
  A `vi.fn()` mock can never catch this: a plain function is indifferent to its
  receiver. Regression cover must be receiver-aware — see
  `packages/local-runtime/src/__tests__/local-runtime-fetch-receiver.test.ts`,
  which uses both a receiver-sensitive and a receiver-recording fetch (the
  latter is what pins the bind; the former cannot, since it tolerates
  `undefined`).
- Ollama `/api/tags` is a mixed catalog: completion, embedding, and image-only
  models can all appear. Catalog hydration MUST resolve every candidate through
  authoritative `POST /api/show` capabilities before exposing it. A failed
  capability lookup fails the catalog visibly; never infer chat support from a
  model name after Ollama is reachable. Only `completion` models enter the
  Assistant picker, while `embedding` remains available to embedding settings.
  Preserve native-first catalog endpoint order even when the availability probe
  succeeded through `/v1/models`. When `/api/tags` itself is unsupported, the
  OpenAI-compatible `/v1/models` fallback remains valid and MUST NOT be followed
  by a native `/api/show` request; its capability source stays `inferred`.
  A forced catalog refresh MUST also force every native `/api/show` lookup so
  `Probe now` cannot reuse stale per-model capabilities after a pull or model
  replacement.
- Per-model vision: `LocalRuntimeNormalizedModel.capabilities.vision` is
  tri-state ('supported' | 'unsupported' | 'unknown'). Ollama `/api/show`
  capabilities and LM Studio's native `type` discriminant ('vlm' vs 'llm')
  resolve it authoritatively; the name-inferred OpenAI-compat path stays
  'unknown' — never coerce unknown to unsupported. It rides through
  `toRuntimeProviderModels` into the picker metadata and the composer
  attachment gate (see docs/agents/assistant-persistence.md, image
  attachments).
- Built-in local provider:
  - Desktop/web local inference targets `onnx-community/gemma-4-E2B-it-ONNX` only.
  - No silent fallback to WASM. If WebGPU is unavailable, the built-in local provider is unavailable.
  - DESKTOP runs local chat through the assistant server's real Mastra loop
    (persistence, run events, tool guards); inference is proxied to the hidden
    llm-host. The built-in local model is also selectable as the observational
    memory model and local embedders as the semantic recall embedder — all
    keyless. See LOCAL LLM ARCHITECTURE.
  - Local tool-call arguments must parse as a root JSON object before a
    provider tool-call part is emitted. Gemma normalization and the hidden-host
    provider projection share the same validator. A malformed call terminates
    generation with `local_tool_call_arguments_invalid`, bounded diagnostics,
    and no approval snapshot; it is never repaired from raw text or coerced to
    `{}`. Valid arguments are canonicalized before Mastra sees them.
  - The broad `@brainstrike/agent` entrypoint explicitly registers the
    browser-only in-process local language-model factory. Server-safe subpaths,
    especially `@brainstrike/agent/hosted-web`, must never import or register
    that Transformers/Hugging Face graph. Selecting the in-process `local`
    provider without first importing the broad root entrypoint fails visibly;
    the Desktop hidden-host client path remains available without that browser
    factory. Do not make local-provider behavior depend on an undocumented
    narrow-entrypoint import order.
  - API keys:
  - Managed via Settings: the Credential Inventory table (BST-1362,
    `packages/settings-ui/src/settings/secrets/credential-inventory/`) — one
    always-visible row per credential slot, no provider dropdown. Slots are a
    SUPERSET of registry providers: every registry entry with `authType`
    `api_key` or `aws` gets a row (keyless local runtimes keep their own
    category; `oauth_subscription` providers get their own surface), plus the
    Tavily web-search key, which deliberately lives outside the LLM registry.
    Each row shows the canonical VENDOR env name (`providerVendorEnvKey`;
    Tavily: `TAVILY_API_KEY`), a `Stored` / `Env (VAR)` / muted `Not set`
    status, and for stored keys the non-secret `…last4` + saved-date
    fingerprint. Editing is an inline expanded row (Enter saves, Escape
    cancels via a window-capture listener so no enclosing surface reacts;
    registry `keyNotes`/`keyFormatHint`/`docsUrl` render inside the editor).
    Env rows are read-only with a lock — the env var is authoritative, so
    mutation buttons never render inert. The `aws` authType renders a TWO-MODE
    editor (BST-1353): an "API key" / "AWS profile" switch
    (`credential-mode-bearer-<slot>` / `credential-mode-profile-<slot>`)
    chooses between saving `{type:'aws', mode:'bearer', bearerKey, region}`
    and `{type:'aws', mode:'profile_chain', region, profile?}`. Bearer is the
    default draft mode — it is the form that works with no local AWS setup at
    all, so it stays the zero-config starting point. The region is MANDATORY
    and `isValidAwsRegion`-gated in BOTH modes (a chain interpolates the same
    request hostname); the profile input
    (`credential-profile-input-<slot>`) is ALWAYS optional — blank means the
    chain's own default resolution, a legitimate configuration — and a
    profile-chain save demands no secret at all. Consequently a profile-chain
    credential carries NO `…last4` fingerprint: there is no secret to
    fingerprint, so `buildCredential` skips it entirely rather than calling
    `createStoredKeyFingerprint` (which throws on an empty string, by design).
    A profile-chain explainer (`credential-profile-hint-<slot>`) names what
    the chain resolves and that it is desktop-only. Saves go through
    the TYPED `saveCredential` bridge exclusively (no `saveKey` fallback — a
    preload without the typed method fails visibly). Deprecated-env renames
    from the status probe (BST-1361 `deprecatedEnvVars`) render as an inline
    amber per-row warning. Rows sort configured-first (Stored, Env, then Not
    set), registry order within groups. `<CredentialInventory
    providers={['openai']}/>` is the reusable filtered seam BST-1358
    consumes. Paired tests:
    `packages/settings-ui/src/settings/secrets/__tests__/credential-inventory.test.tsx`,
    desktop e2e `apps/desktop/e2e/secrets-settings.test.ts`.
  - Desktop: encrypted keychain.
    Stored keychain values are typed provider credentials (BST-1348): the
    stored value is `JSON.stringify(credential)` of the `ProviderCredential`
    union (`api_key` | `oauth` | `aws`) declared in
    `packages/assistant-contract/src/provider-credential.ts`, encrypted exactly
    like the legacy bare-string keys. EVERY write goes through one path:
    `saveKey` delegates to `setCredential({ type: 'api_key', key })`, so even
    string saves store the JSON envelope (a pasted GCP service-account JSON —
    which carries `"type":"service_account"` — therefore round-trips verbatim
    instead of tripping tag validation on read). Reads apply the settled
    legacy mapping forever: a decrypted value that never claims a `type` tag
    (not JSON, non-object JSON, or a JSON object without a `type` property) IS
    `{ type: 'api_key', key: <raw string> }` — a defined mapping covering every
    pre-existing stored key, not a fallback. A value that carries a `type` tag
    but is unrecognized or fails field validation throws a `SecretReadError`
    with the `malformed_credential` code — it is never coerced into an api_key,
    and `MalformedCredentialError` messages are static (no tag or field
    values). Field rules: an `api_key` key must be non-empty; `aws` splits by
    mode — `bearer` requires `bearerKey`, `profile_chain` keeps `profile`
    optional (default chain is legitimate).
    `SecretsService.getKey` returns `.key` only for `api_key` credentials; any
    other stored type throws `SecretReadError('credential_type_unsupported')`,
    so string-only consumers stay inside the existing read-failure contract:
    the assistant HTTP path returns the structured `api_key_unreadable` 400.
    Availability inspection (`inspectProviderKeys`) reads TYPED credentials
    since the BST-1352 review: a VALID stored credential of ANY type marks the
    provider configured (`providerKeySources` entry with `source: 'stored'`),
    so the availability verdict and the typed-consumer verdict cannot diverge
    when wave-3 consumers land; only malformed/unreadable entries surface as
    per-provider `readFailures` repair entries (the other providers stay
    listed). `secrets:listStored` id enumeration stays value-blind.
    `secrets:list` (BST-1362) additionally projects the save-time
    `{last4, savedAt}` fingerprint onto stored entries: the Credential
    Inventory writes it into the credential's non-secret `metadata` at save
    (both `api_key` and `aws` carry an optional string-record `metadata`;
    `oauth` has none), and only those two keys ever cross the wire — never
    key material, never other metadata. A fingerprint exists only when BOTH
    keys are present (the single save path always writes them together); a
    partial pair is withheld, and an unreadable stored credential still lists
    as `source: 'stored'` without metadata (its read failure surfaces through
    the status probe and every actual read path). Wire-shape validation is
    the ONE shared parser `parseProviderKeySources`
    (`packages/assistant-contract/src/provider-key-source.ts`, paired test
    `provider-key-source.test.ts`) used by BOTH strict renderer consumers —
    the settings Credential Inventory and the assistant-preferences
    configured-provider probe — so the accepted payload shape cannot drift;
    malformed fingerprint metadata is a visible parse failure, never guessed
    at. `credential_type_unsupported`
    and `malformed_credential` join `decrypt_failed` /
    `encryption_unavailable` in the shared `SecretReadErrorCode` union; all
    stay distinct from the `null` "not set" result.
    Typed consumers use `getCredential` / `setCredential` and the renderer
    bridge's `saveCredential` / `getCredential` (channels
    `secrets:saveCredential` / `secrets:getCredential`, same visible-UI-only
    policy as every secrets channel). Secrets IPC channels never throw domain
    errors across invoke (Electron drops custom error props): writes resolve
    `true | { ok: false, error: 'malformed_credential' |
    'encryption_unavailable' | 'unknown_error' }` and `secrets:getCredential`
    resolves `{ ok: true, credential | null }` or the serialized failure
    `{ ok: false, error: SecretReadErrorCode, provider }`. `setCredential`'s
    guard is the single write validator; handlers only map its errors. The
    `window.secrets` shape is defined once as `SecretsBridge` in
    `packages/assistant-contract/src/secrets-bridge.ts` (required-method pin
    enforced by the preload-runtime contract test; settings-ui consumes the
    derived `SecretsCapability` view with the typed methods optional).
    Test-mode Secrets IPC stores the same serialized envelope forms and reads
    through the same `parseCredentialOrThrow` / `credentialToApiKey` helpers
    as the production service. The full decision table and its paired tests:
    `packages/assistant-contract/src/__tests__/provider-credential.test.ts`,
    `apps/desktop/src/__tests__/secrets.test.ts`, and
    `apps/desktop/src/__tests__/main/ipc-secrets.test.ts`.
    The secrets bridge is a visible-UI capability. Every secrets IPC operation
    declares and enforces the `visible-ui` sender role in the main-process IPC
    registry before arguments are parsed or keychain code runs. Chunking,
    embedding, local-LLM, and untracked renderers are rejected even if they
    invoke the channel directly. Hidden hosts load `hidden-preload.js`, whose
    role manifests contain neither the secrets bridge nor assistant URL/token
    credentials. The assistant auth and URL handlers enforce the same
    independent visible-UI policy; possession of a preload channel is never
    authority.
    Desktop also loads provider credentials from environment files before any
    provider/key inspection runs. `src/main-bootstrap.ts` is the packaged main
    entry: it completes this load before dynamically importing the full
    `src/main.ts` runtime graph, so eager module-level environment reads cannot
    observe a partially initialized process. Unpackaged launches read
    `apps/desktop/.env.local` before `apps/desktop/.env`; packaged launches may
    read only `<userData>/.env`. The inherited process environment is authoritative
    even when an existing value is empty. Every candidate file is read and
    validated before any value is applied, so an unreadable or malformed file
    applies nothing and surfaces through both the assistant status probe and
    Settings (the Settings surface and its names-only payload rule are
    specified under "Env bootstrap visibility (BST-1363)" below).
    Files may set only the credential names documented in
    `apps/desktop/.env.example`; arbitrary process variables are rejected so a
    packaged user-data file cannot alter child-process execution. Assignment
    boundary whitespace is rejected rather than silently trimming a credential
    value. Missing files are valid. `NODE_ENV=test`,
    `ELECTRON_IS_E2E_TEST=true`, and `--test-mode` disable environment-file
    loading entirely; directly injected launch variables retain their existing
    runtime semantics.
    Canonical env names (BST-1361): every keyed provider resolves EXACTLY two
    environment names, in order `BRAINSTRIKE_<PROVIDER>_API_KEY` (app-scoped
    override, wins) then the vendor-standard name — the full precedence chain
    is `BRAINSTRIKE_*` > vendor name > stored keychain secret.

    | Provider   | Override                          | Vendor-standard                | Deprecated (never authenticate)                                                    |
    | ---------- | --------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
    | openai     | `BRAINSTRIKE_OPENAI_API_KEY`      | `OPENAI_API_KEY`               | `BS_OPENAI_API_KEY`, `AI_OPENAI_API_KEY`, `OPENAI_API_KEY_V1`, `OPENAI_API_KEY_V2` |
    | anthropic  | `BRAINSTRIKE_ANTHROPIC_API_KEY`   | `ANTHROPIC_API_KEY`            | `AI_ANTHROPIC_API_KEY`                                                              |
    | google     | `BRAINSTRIKE_GOOGLE_API_KEY`      | `GOOGLE_GENERATIVE_AI_API_KEY` | `GOOGLE_API_KEY`, `AI_GOOGLE_API_KEY`                                               |
    | openrouter | `BRAINSTRIKE_OPENROUTER_API_KEY`  | `OPENROUTER_API_KEY`           | `AI_OPENROUTER_API_KEY`                                                             |
    | cohere     | `BRAINSTRIKE_COHERE_API_KEY`      | `COHERE_API_KEY`               | `AI_COHERE_API_KEY`                                                                 |
    | voyage     | `BRAINSTRIKE_VOYAGE_API_KEY`      | `VOYAGE_API_KEY`               | `AI_VOYAGE_API_KEY`                                                                 |
    | bedrock    | `BRAINSTRIKE_BEDROCK_API_KEY`     | `AWS_BEARER_TOKEN_BEDROCK`     | —                                                                                   |
    | tavily     | `BRAINSTRIKE_TAVILY_API_KEY`      | `TAVILY_API_KEY`               | —                                                                                   |

    `provider-catalog.json` (`envKeys` + `deprecatedEnvKeys`) is the single
    source of truth; `provider-registry.ts` only types it — see "Provider
    catalog data ownership" below. Deprecated names obey three invariants, all
    tested: they stay in the desktop `.env` allow-list forever (an
    unrecognized name rejects the WHOLE file, so removal would brick existing
    user files); they stay in the child-env credential scrubber forever (a
    credential-shaped var must never leak to children); and they are ABSENT
    from every resolution list, so a deprecated var never authenticates.
    Scope: the scheme and its deprecation claims cover exactly the seven keyed
    providers above (bedrock's "key" is a Bedrock API bearer token; see the
    Amazon Bedrock section for its region rule). The desktop allow-list is a
    UNION since BST-1350: the registry-derived CREDENTIAL set
    (`CREDENTIAL_ENV_FILE_VARIABLE_NAMES`, which alone drives the child-env
    credential scrub) plus the deliberate NON-credential set
    (`NON_CREDENTIAL_SUPPORTED_ENV_FILE_VARIABLE_NAMES`, today exactly
    `AWS_REGION` and — since BST-1353 — `AWS_PROFILE`) — both are
    configuration, not secrets, so children may inherit them while every
    bearer name is still stripped (desktop-env.test.ts pins both directions).
    `AWS_PROFILE` NAMES a profile in the user's `~/.aws/config`; the
    credentials it points AT are secret but live in the user's AWS
    configuration and never pass through this process env, so scrubbing the
    name would break `aws` CLI children while protecting nothing.
    `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` are
    NOT `.env`-loadable (the registry never produces them, and file-loading
    them would create a new credential channel), but they ARE in
    `SCRUBBED_CREDENTIAL_ENV_VARIABLE_NAMES` — the scrub is a DENY-LIST, so an
    unlisted ambient credential reaches children verbatim (PR #2525 review,
    finding 1). They can still ACTIVATE the credential chain from the
    INHERITED process environment, because the file allow-list governs what a
    `.env` FILE may set, not what the chain may see.
    Separately, the code-execution FENCE allow-list
    (`INHERITED_ENV_VARS` in `packages/agent/src/fence/fence-executor.ts`)
    contains NO `AWS_*` name and must not gain one: chain resolution is
    desktop-main-only and sandboxed user code has no business signing AWS
    requests. The local runtimes' optional embeddings bearer tokens
    (`OLLAMA_API_KEY`/`AI_OLLAMA_API_KEY`, `LMSTUDIO_API_KEY`/
    `AI_LMSTUDIO_API_KEY`) are separate LIVE transport names outside the
    registry scheme — not deprecated, not `.env`-file-loadable (they are not
    allow-listed), resolved only from the launch environment by the
    embeddings resolver. Consolidating them is flagged for the BST-1362/1358
    settings work.
    When set, they surface visibly: desktop main detects them once at startup
    (`detectDeprecatedProviderEnvVars`), logs a warning, and `/assistant/status`
    (and the Hosted Web status route) carry
    `deprecatedEnvVars: [{provider, envVar, replacement}]` — names only, never
    values (the Credential Inventory renders them as per-row rename
    warnings, BST-1362). Consumers that cannot
    import the registry (`packages/indexing-contract`) are pinned by
    `scripts/__tests__/provider-env-keys-mirror-contract.test.mjs`;
    `apps/desktop/.env.example` is pinned by
    `apps/desktop/src/__tests__/main/env-example-contract.test.ts`.
    Chat and model-metadata environment credentials remain authoritative when
    present. A stored-key `SecretReadError` must otherwise propagate as the typed
    `api_key_unreadable` chat/model-metadata failure (or the original typed
    embedding failure); it must never be coerced into `missing_api_key`.
    Embeddings may continue with a valid environment credential after a stored
    read failure, but must rethrow that failure when no environment key exists.
    `SecretReadErrorCode` and its runtime guard live in the shared assistant
    contract; desktop producers and renderer status parsing must use that single
    definition. Malformed provider-error payloads fail the status probe visibly
    rather than being dropped, so a protocol violation can never masquerade as
    healthy provider availability. Saving, replacing, or deleting a provider
    secret must re-probe assistant status so an unreadable-key error cannot
    remain latched after the credential is repaired.
    Provider-backed memory follows the same authority chain. Observational
    memory and semantic recall distinguish `disabled`, `resolved` (built-in
    local targets only), and `needs_async_resolution` states; the latter
    performs the env/keychain lookup before constructing Mastra memory. The
    old request-key `resolved` fast path for hosted targets is RETIRED
    (BST-1352 review): RuntimeData no longer carries the request's bearer key
    (credentials travel only as the direct authInput parameter), so every
    hosted memory target resolves through the same env/keychain chain the
    request used — value-identical, and the memory cache absorbs the extra
    read. A completed lookup with no key
    returns HTTP 400 `memory_credential_missing` with the bounded provider and
    `observational_memory` or `semantic_recall` feature. A `SecretReadError`
    remains `api_key_unreadable`. Renderer memory gates must prefer the matching
    validated `providerErrors` repair message over generic missing-key guidance;
    another healthy provider must never mask an unreadable memory credential.
    The renderer and Settings consume the validated configured-provider signal
    from assistant status. A hosted observer or embedder without a configured
    key is excluded from selectable memory models, prevents its feature toggle,
    and blocks the next run with actionable guidance; built-in local models
    remain keyless. The serialized model target is never sufficient evidence
    that a credential exists. An omitted `providerKeySources` field means the
    host does not expose credential provenance; it is not equivalent to a
    validated empty list. Hosted Web therefore retains its server-owned model
    surface and reports the host capability boundary before desktop-only
    credential guidance.
    Built-in local observational memory additionally requires the desktop
    assistant-server bridge. Web's in-renderer local chat does not construct
    PGlite/Mastra observational memory, so Settings excludes the local observer
    unless that capability is positively present and the runtime blocks a
    persisted local observer with an explicit desktop-backend reason.
    Hosted-provider chat likewise requires a positively available Mastra memory
    backend before request preparation. The composer gate and request-data
    builder consume one shared capability predicate; do not duplicate the
    provider/backend rule. Core PGlite readiness, memory-load failures, and
    selected-thread availability also apply when no workspace root is open.
    Only root-scoped observational-memory and semantic-recall checks may be
    bypassed in that state; request-memory failures must disable the composer
    instead of reaching the strict request-memory assertion.
  - Hosted Web: local Vite and protected Vercel Preview may read server-only
    OpenAI, Anthropic, Google, and OpenRouter environment keys using each
    provider registry entry's canonical precedence. Whitespace-only values are
    unconfigured. Status advertises configured provider IDs and exact safe
    environment-key sources, never values; each advertised provider is fixed to
    its registry default model in the renderer. A request may select only one of
    that configured set. Unknown, non-Hosted-Web, and credential-less providers
    fail as `invalid_runtime_data` / HTTP 400 rather than falling back to another
    key. The server injects the selected provider's key and ignores client
    model/key/base-URL attempts. Because the Vite process holds developer
    credentials, its assistant
    middleware has an explicit LOCAL request boundary before status, body
    parsing, or stream dispatch: the TCP peer must be IPv4/IPv6 loopback, the
    `Host` must be exactly `localhost` or a loopback IP authority, and browser
    `Origin` / Fetch Metadata must be same-origin. A loopback CLI request with no
    `Origin` remains supported. Assistant POSTs additionally require
    `Content-Type: application/json`; remote clients, DNS-rebinding hosts,
    cross-origin browsers, and non-JSON media types receive stable typed
    403/415 errors while their request stream is drained. Do not weaken that
    application boundary merely because Vite also has listener/allowed-host
    controls. The deployable Vercel entrypoints enable that key only when
    `VERCEL_ENV=preview`; missing, development, production, and unknown values
    fail closed as `production_auth_required`. Production enablement requires
    application authentication plus distributed quota/cost controls. Never
    expose a key through a `VITE_`-prefixed variable. The shared renderer's
    model, generation, loop, MCP, and enabled-tool fields are wire-compatibility
    hints only and are never copied into that trusted runtime. The provider field
    is the sole exception: it is copied only after exact membership validation
    against the server-configured Hosted Web provider set — and since the
    BST-973-2 convergence it is REQUIRED on assistant turns. Both Hosted Web
    transports (the Vercel function and the Vite dev/preview middleware) run one
    converged decision core (`runWebAssistantPost` in
    `apps/web/src/server/web-assistant-post.ts`, which passes the allow-list
    `filterWebAssistantPayload` as the SHARED `prepareAssistantPostRequest`'s
    `filterPayload` hook — BST-1030). The hook's ORDERING is a contract, pinned
    by tests in `packages/assistant-service/src/__tests__/request.test.ts`: it
    runs on the parsed envelope AFTER `parseAssistantRequestPayloadText` and
    BEFORE tool-continuation extraction and native-tool-id validation, so what
    the filter strips can never reach validation, and the hook's own typed
    errors propagate OUT of preparation to the transport-owned mapping (they
    are never mapped inside the package). A refactor that moves or bypasses
    this hook moves web's trust boundary — update the tests and this section
    together. With the hook in place, a
    request that names no `data.provider` is rejected `missing_provider` /
    HTTP 400 exactly like desktop — the old web-only default-provider fallback
    is gone, and the 503 server-config gate precedes request validation. Do not
    reintroduce a fallback in either transport; the shared renderer always
    names its provider.
    `resolveWebAssistantRuntime` (still the chat endpoint's boundary) and the
    assistant pre-filter copy an explicit allowlist of non-privileged
    request metadata only after strict runtime validation of every value,
    including bounded strings, arrays, numbers, and strict nested objects.
    Malformed known fields and server-only, capability-inapplicable, or unknown
    fields (including `apiKey`, `mcpConfig`, `mastraTools`, `permissionPolicy`,
    and `permissionPolicyRequest`) fail with
    `invalid_runtime_data` / HTTP 400. TypeScript types alone are not a request
    trust boundary. The Web request therefore cannot create tools, launch stdio
    MCP, replace provider credentials, or set server cost policy through
    serialized runtime data. Hosted Web has an explicit 4 MiB serialized
    request-body capability, below Vercel Functions' non-configurable 4.5 MB
    ingress ceiling. App-shell passes that capability only when the desktop
    assistant bridge is absent, and the shared renderer measures the exact
    UTF-8 JSON body before `fetch`, so normal Web UI turns fail visibly before
    the platform can substitute its generic `FUNCTION_PAYLOAD_TOO_LARGE`
    response. The Vercel Function handler and Vite dev/preview middleware
    enforce the same 4 MiB maximum before JSON parsing;
    `BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES` accepts only a positive
    safe integer and may lower that server cap but never raise it. Declared and
    streamed/chunked overflow is byte-counted
    and fails with `request_body_too_large` / HTTP 413 while the Node stream
    drains. A direct Vercel request above the platform's 4.5 MB limit can still
    be rejected before Brainstrike code runs. Desktop retains the canonical
    16 MiB server limit. Restoring larger inline-image turns on deployable Web
    requires direct blob/object-storage uploads instead of routing base64
    through the Function. Malformed JSON fails without logging its value as
    `invalid_json` / HTTP 400; an empty or whitespace-only body is malformed
    JSON rather than an implicit empty request. The canonical assistant request
    envelope has exactly four possible top-level fields: required `messages`
    plus optional `data`, `runConfig`, and `unstable_assistantMessageId`.
    `messages` must be an own array (an empty array is valid for approval and
    suspend/resume action legs), while present `data` and `runConfig` must be
    objects. Missing `messages`, non-object roots, invalid optional objects, and
    every unknown top-level field fail as `invalid_request_payload` / HTTP 400
    on Vercel Preview, Vite dev/preview, and Desktop. The renderer constructs that exact
    shape through the shared assistant-contract helper. It omits assistant-ui
    thread/parent bookkeeping because the message graph and `data.memory` own
    topology, and rejects non-empty client `callSettings`, `config`, `system`,
    `tools`, or message state before fetch because the custom server consumes
    none of them. In particular, provider API keys/base URLs and per-call
    headers can never leak through assistant-ui's generic model-context bags.
    `runConfig` is bounded by the active transport cap (4 MiB Web, 16 MiB
    Desktop); only the shared approval/suspend action readers consume it, and a
    suspend action's `resumeData` is then validated by the tool's Mastra resume
    schema. Do not
    forward any other `runConfig` subtree: expanding that contract first
    requires shared graph, identifier, and UI-input bounds.
    This envelope reduces and secures HTTP transport bytes; model-context
    savings remain the separate memory/projection/compaction contracts below.
    Before recursive assistant-ui compatibility normalization, the shared
    iterative message boundary caps message and part counts, graph nodes/depth,
    object fields, and string sizes. It rejects
    cycles, non-plain objects, and non-JSON scalars (including bigint and
    non-finite numbers) while permitting `undefined` for optional in-memory
    fields. Violations fail as `invalid_messages` / HTTP 400. Message conversion
    is role-, part-, and path-aware: it reads only root compatibility text and
    direct `content`/`parts` text fields, and recognizes attachments only as
    direct file parts on user messages. Tool calls, tool results, data parts, and
    their nested domain payloads remain opaque, so a workspace entry such as
    `{type:"file",path:"README.md"}` can never collide with the attachment
    discriminator or be flattened into prompt text. The elevated data-URL string
    allowance likewise applies only at those exact user-file positions; every
    other string remains under the normal graph budget. An image attachment is
    prompt content in its own right, so validated
    image-only user turns are accepted consistently by Vercel Preview, local
    Vite, and Desktop.
    Blank text-only turns and turns ending in assistant/system history remain
    invalid. Prompt validity is checked against the FINAL raw wire entry before
    lossy compatibility normalization, never against the last surviving history
    message; a dropped blank/tool-only tail therefore cannot replay an earlier
    user prompt. Attachment limits count wire occurrences rather than object
    identity. File parts require canonical
    base64 alphabet, length, and padding, and the data-URL media type must equal
    the declared allowlisted image media type. An empty base64 body is invalid
    (`invalid-base64`), never a canonical zero-byte image. Malformed direct file
    parts and attachment validation failures return a safe `invalid_attachment`
    / HTTP 400 response across Vercel Preview, Vite dev/preview, and Desktop.
    Approval resume actions
    likewise cross a strict shared boundary: only the exact `action`, `runId`,
    `toolCallId`, and optional
    `toolName` own keys are accepted; identifiers must be non-empty and stay
    within the documented 512-character transport ceilings. Extra keys and
    oversized identifiers return `invalid_tool_approval_action` / HTTP 400 on
    both Vercel Preview and Vite dev/preview routes. Suspend-resume actions use
    the same exact-own-key and 512-character identifier bounds; extra keys,
    inherited fields, blank tool names, and oversized identifiers return
    `invalid_tool_resume_action` / HTTP 400. After normalization, chat requests
    require at least one effective message and normal assistant turns require a
    non-empty prompt on both Vercel Preview and Vite dev/preview routes. Hosted
    Web has no durable workflow or stream-replay store. Both Vercel Preview and
    Vite dev/preview therefore reject valid approval and suspend-resume
    actions with typed HTTP 409 responses, and reject every non-empty
    `Last-Event-ID` as `stream_resume_unavailable` instead of depending on lucky
    process affinity. These requests still consume the bounded body first, so a
    reconnect cannot bypass the cap. Normal turns call the shared stateless Web
    stream builder without a Mastra storage argument and create a single
    non-registering data-stream response. They never enter the desktop
    process-local replay map or retain encoded output for its two-minute replay
    window.
    Wire-compatible provider/model/tool hints are strictly bounded and validated
    before they are discarded, including iterative
    depth/cardinality/string/number limits for arbitrary provider options. The
    UI's `transportImageElision` observability metadata follows the same rule:
    Web accepts only the bounded, strict shared-contract shape and discards it
    before building the trusted model runtime.
    The Vite deployment declares real root `api/assistant.ts` and
    `api/assistant/status.ts` Vercel Function entrypoints; `src/app/api/**`
    alone is not discoverable in a static Vite project. Those wrappers enforce
    the protected-preview-only deployment boundary before delegating. The
    legacy `/api/chat` handler remains dev-only because its process-local rate
    limiter cannot enforce a production limit across function instances.
- Config:
  - packages/agent/src/providers/registry.ts
  - packages/agent/src/providers/key-resolver.ts
  - packages/agent/src/providers/provider-factory.ts
  - User setup: docs/local-model-servers.md
- OpenRouter is configured through Mastra's `openrouter/<provider>/<model>`
  model-router IDs, not a generic `createOpenAI({ baseURL })` client. The
  factory materializes the `ModelRouterLanguageModel` itself and injects the
  strict-content gateway
  (`packages/agent/src/providers/openrouter-strict-content.ts`): the OpenRouter
  chat serialization emits `content: text || null` for assistant messages, so a
  replayed tool-call-only assistant turn reaches the wire as `content: null`,
  which Alibaba-hosted `qwen/*` models 400 on
  (`invalid_parameter_error: The content field is a required field.`,
  field failure 2026-08-16). The gateway CLAIMS only strict-content model
  families (`qwen/*`) — every other OpenRouter model still resolves through
  Mastra's own models.dev gateway untouched — and resolves them via the same
  `@openrouter/ai-sdk-provider` version Mastra bundles (workspace-catalog pin,
  guarded against vendored-copy drift by
  `scripts/__tests__/openrouter-provider-mirror-contract.test.mjs`) with a
  fetch that coerces `null` → `""`. A blanket rewrite is unsafe because
  OpenRouter re-normalizes messages for Anthropic-style upstreams where an
  empty text block is itself invalid. Paired spec (incl. a request-equivalence
  test against the models.dev path):
  `packages/agent/src/__tests__/openrouter-strict-content.spec.ts`.
  Retire the gateway when the upstream converter stops emitting `null`. The
  official OpenRouter adapter preserves `providerMetadata.openrouter.usage.cost`;
  that exact billed amount is aggregated across `step-finish` parts and carried
  on the terminal message. Mastra emits approval/tool-suspension parts before it
  exposes that model step's `step-finish`, so a pause finish cannot claim an exact
  cost. On resume Mastra emits the deferred pre-pause `step-finish` before later
  model steps; the fresh resumed lifecycle aggregates all of them on the final
  message without double-counting. An abandoned pause therefore has no billed
  cost available through the observer stream. Mastra's terminal token usage is
  cumulative, but its terminal provider metadata repeats only the final step, so
  a missing cost cannot be repaired from the terminal metadata.

  **A MISSING COST RECORDS UNKNOWN; ONLY A MALFORMED ONE FAILS — do not
  relitigate.** OpenRouter reports no `usage.cost` for anonymous/stealth routes
  (`stealth/ox-alpha`, migration 107), so requiring one from every step failed
  EVERY such turn at the finish, discarding a completed answer over billing
  telemetry. Cost accounting is observability, and observability must not
  destroy the product it observes. An incomplete picture — no step reported, or
  only some did — therefore records the turn cost as UNKNOWN (omitted, stored
  null) with a visible `provider_billed_cost_unreported` warning that names the
  partial case and the amount it is discarding. Never zero, and never a partial
  sum presented as the total, which is the undercount the old rule was really
  guarding. A genuine `cost: 0` remains a MEASURED zero.

  MALFORMED metadata is loud but equally non-fatal. `readOpenRouterBilledCost`
  returns a three-way reading — `absent` | `malformed` | `reported` — rather
  than a number-or-throw, so the callers must handle the broken-contract case
  explicitly (nothing is coerced, and it cannot be swallowed the way a
  `try`/`catch` would). They log `provider_billed_cost_malformed` at ERROR and
  treat the step as unpriced, which resolves the turn to unknown. Absent is a
  fact about the route; malformed is a broken contract someone should fix.
  Neither destroys a completed turn, and neither becomes zero.
- Reasoning has two INDEPENDENT dimensions, and they must not be re-conflated
  (BST-840). DEPTH is a budget concern (`reasoningEffort`, `anthropicEffort`,
  `googleThinkingLevel`, the OpenRouter auto profile). VISIBILITY is a UX
  concern — whether the provider returns the reasoning at all — and is owned by
  the single cross-provider `reasoningVisible` setting, resolved by
  `packages/assistant-contract/src/reasoning-visibility.ts` (defaults to
  visible). Each provider projects it onto its own wire field:
  `openai.reasoningSummary`, `anthropic.thinking.display`,
  `google.thinkingConfig.includeThoughts`, `openrouter.reasoning.exclude`.
  Three hard rules: visibility only ever MODIFIES a reasoning request that is
  already being made (cleared settings must still produce NO provider options);
  output is never suppressed/summarized for reasoning that is switched off; and
  the OpenRouter VISIBLE path adds NO field at all, because OpenRouter already
  returns reasoning and `provider.require_parameters` narrows routing to
  endpoints supporting every supplied parameter — an unconditional extra field
  would shrink the eligible upstream pool on every request. Only the OpenRouter
  opt-out adds `exclude: true`. Do NOT reintroduce a default
  `openrouter.reasoning.summary`: it is not part of OpenRouter's documented
  reasoning object (`effort`, `max_tokens`, `exclude`, `enabled`).
  Provider-specific keys remain valid escape hatches and win when explicitly
  set — and each one's control must render the RESOLVED value, not the raw key,
  or it reports stale state (the Google include-thoughts switch and the
  OpenAI/OpenRouter summary select both do this).
- The Anthropic Thinking toggle is AUTHORITATIVE for "is Claude thinking".
  Because a model-supported `anthropicEffort` implies adaptive thinking,
  switching the toggle off clears the effort as well as the budget; otherwise
  the runtime keeps requesting thinking while the switch reads unchecked.
- Anthropic thinking mirrors the installed `@ai-sdk/anthropic` discriminated
  union: `adaptive` (carries `display`, whose provider-side default is
  `omitted`), legacy `enabled` + `budgetTokens`, and `disabled`. An explicit
  budget pins the legacy form; otherwise a supported effort emits `adaptive`.
  The `AnthropicEffort` TYPE spans `low|medium|high|xhigh|max`, in step with
  the SDK enum, and is declared identically in BOTH
  `packages/assistant-contract/src/runtime-data.ts` and
  `packages/agent/src/types.ts` (the latter is what actually hands
  `providerOptions` to the SDK, and the boundary is structural — a narrower
  type there diverges SILENTLY). The OFFERED ladder is now declared per model
  in `LlmModelDefinition.anthropicReasoning` (BST-847), typed `AnthropicEffort`
  and separate from the OpenAI-vocabulary `reasoning` block. It is recorded
  from vendor documentation, never derived from union membership: Fable 5,
  Opus 5, Opus 4.8, and Sonnet 5 offer `low|medium|high|xhigh|max`; Sonnet 4.6 offers
  `low|medium|high|max` (NO `xhigh`). Each defaults to `high`. Haiku 4.5
  declares NO effort ladder: effort is unsupported, while thinking keeps the
  legacy `enabled` + `budgetTokens` form. Sources, retrieved **2026-09-04**:
  https://platform.claude.com/docs/en/build-with-claude/effort and
  https://platform.claude.com/docs/en/about-claude/models/overview.
  Opus 5 rejects thinking disabled with `xhigh` or `max`; the supported-effort
  path emits adaptive thinking. Switching Thinking off clears effort and budget;
  for Opus 5 only, cleared settings explicitly emit `thinking.type: disabled`
  because omission enables thinking by default on this model. Other models keep
  their existing omission behavior. Its
  direct catalog row is seeded disabled (migration 116), preserving existing
  user toggles. Pricing includes $10/MTok for one-hour cache writes, retained
  here because the registry represents only the five-minute cache-write rate.
  `resolveReasoningControlsAvailability` reads the declared ladder/default;
  Haiku gets an empty ladder so its Effort row disappears while its Thinking
  toggle remains. A missing or uncatalogued id (direct Anthropic uses the
  registry model allow-list, with no custom-model option, so this is the
  no-selection edge) gets the SAME empty-ladder shape, not `available: false`:
  the request builder still sends a persisted legacy budget for such an id,
  and the toggle is authoritative for "is Claude thinking", so it must stay
  visible and clearable; only the ladder is withheld.
  `buildAnthropicOptions(modelName, settings)` treats an effort outside the
  model's ladder, including no ladder or no registry row, as ABSENT: no effort
  and no derived adaptive thinking, never a neighbouring effort. An explicit
  legacy budget still survives independently. Controls display rejected
  persisted efforts as Auto and do not count them as active thinking.
  `reconcileAnthropicSettingsForModel` strips unsupported efforts on explicit
  switches to declared models, preserves budgets/unrelated settings and
  identity when unchanged, and leaves uncatalogued models alone (the Bedrock
  rule). The global-switch update key list includes `anthropicEffort` so its
  removal persists as `anthropicEffort: undefined`.
- The OpenAI-family effort vocabulary has exactly ONE declaration:
  `OPENAI_REASONING_EFFORT_VALUES` in `@brainstrike/types`
  (`assistant-provider-settings.ts`), with `OpenAiReasoningEffort` derived from
  it. `packages/assistant-contract/src/runtime-data.ts` and
  `packages/agent/src/types.ts` RE-EXPORT it, and the Hosted Web request
  boundary (`apps/web/src/server/web-assistant-runtime-schema.ts`) builds its
  `z.enum` from the same const, reached through `@brainstrike/agent/hosted-web`
  so the enum and the `RuntimeData.requestedReasoningEffort` it guards come from
  one source. Do NOT re-declare it. The contrast with `AnthropicEffort` is the
  whole point: that one mirrors a zod schema `@ai-sdk/anthropic` never exports
  as a value, so its three copies are unavoidable and are policed by
  `scripts/__tests__/ai-sdk-anthropic-mirror-contract.test.mjs`. The OpenAI
  copies were deleted, but the single const still mirrors an upstream
  vocabulary: the installed `@ai-sdk/openai` now ships `reasoningEffort` as a
  literal union in its chat-options declaration. Membership and the version
  annotated on the const (the ONLY place the pin lives — do not repeat the
  number here) are policed by
  `scripts/__tests__/ai-sdk-openai-mirror-contract.test.mjs` against the
  installed provider's `dist/index.d.ts`. This contract covers the platform
  `openai` provider's chat options only: the Responses-API `reasoningEffort` is
  an open `string`, not an enumerable oracle, and OpenRouter's cross-vendor
  values are still governed per model by `resolveReasoningControlsAvailability`,
  not by this contract. Because the same const types OpenRouter's per-model
  ladders, a WIDER finding (a value OpenAI's chat schema dropped) is a
  decision, not a deletion order: drop the value if no provider routes it, or
  split the OpenRouter vocabulary out of this const if OpenRouter still does.
  The const is union MEMBERSHIP, not an offered list — the
  `anthropicReasoning` per-model ladder ruling above is unchanged by it. What
  a given model offers stays in `resolveReasoningControlsAvailability`; never express an
  offered-list narrowing by narrowing this union.
  `EFFORT_TRACK_ORDER` in
  `packages/assistant-ui/src/reasoning-effort-controls.tsx` is deliberately NOT
  derived from it. It is a cross-provider display ranking typed
  `readonly string[]` precisely so an unranked value sorts last rather than
  being dropped from the track.
- `OpenAiReasoningSummary` and `GoogleThinkingLevel` follow the same rule and
  for the same reason: declared once in `@brainstrike/types`, re-exported by
  `packages/assistant-contract/src/runtime-data.ts` and
  `packages/agent/src/types.ts`. Neither has a values const, deliberately.
  `OPENAI_SUMMARY_OPTIONS` (`provider-settings-panel.tsx`) is typed
  `OpenAiReasoningSummary | 'off'` — its `off` entry is a UI sentinel, not a
  wire value, so the list cannot be derived from the union. Google keeps its
  offered lists in the same file as the type —
  `GOOGLE_FLASH_THINKING_LEVELS`, `GOOGLE_PRO_THINKING_LEVELS`, and the exact
  `GOOGLE_GEMINI_37_FLASH_THINKING_LEVELS` exception — selected per-model by
  `getGoogleThinkingLevels`. A separate "all values" const sitting beside them
  would still be precisely the offered-vs-membership confusion the
  `anthropicReasoning` offered-ladder ruling exists to prevent. That
  `GOOGLE_FLASH_THINKING_LEVELS` happens to list all four levels today is a fact
  about what earlier Flash models offer, not a definition of the type. Gemini
  3.7 Flash deliberately omits `minimal`, which its official model page says
  returns an error. The shared effort control must render any persisted Google
  level outside the selected model's ladder as `Auto` and keep rejected values
  out of its interactive options; `reconcileProviderSettingsForModel` clears
  that level on an explicit Google model switch. This keeps the visible control
  aligned with the request builder, which declines to send a rejected level.
- The provider-options INTERFACES (`OpenAiProviderOptions`,
  `GoogleProviderOptions`, `AnthropicProviderOptions`, `BedrockProviderOptions`,
  `LocalProviderOptions`,
  `OpenRouterProviderOptions`) are NOT shared between
  `assistant-contract/runtime-data.ts` and `agent/types.ts`, and that is not
  oversight: the contract's extend `RuntimeJsonObject` (a wire-side
  `Record<string, unknown>`) while the agent's extend `JSONObject` from
  `@ai-sdk/provider`, which is the constraint the SDK actually imposes on
  `providerOptions`. They are structurally parallel, not the same type. Unify
  them only by resolving that base-type split first. `BedrockProviderOptions`
  (BST-1354) follows the same rule and was added to BOTH files in one change.
  The base-type split shows through in one visible way: the AGENT-side
  `BedrockReasoningConfig` must be a type ALIAS (with a `biome-ignore` for
  `useConsistentTypeDefinitions`) because an interface member does not satisfy
  `JSONObject`'s string index signature — TS2411, the same reason
  `AnthropicThinkingOptions` is an alias — while the contract-side copy is an
  ordinary interface under `RuntimeJsonObject`. `BedrockReasoningEffort` is NOT
  duplicated: like the OpenAI-family vocabulary it is declared once in
  `@brainstrike/types` and re-exported by both.
- OpenRouter request options use the native `providerOptions.openrouter`
  namespace. The shared reasoning controls map to
  `{openrouter:{reasoning:{effort,summary},provider:{require_parameters:true}}}`.
  Strict parameter routing is mandatory so OpenRouter cannot silently select an
  upstream route that ignores requested reasoning or tool parameters. Optional reasoning models map the
  explicit Off choice to `{openrouter:{reasoning:{enabled:false}}}`; `none` is
  never sent as a guessed effort. Never reuse the OpenAI camel-case
  `{openai:{reasoningEffort,reasoningSummary}}` shape, which Mastra's OpenRouter
  adapter ignores.
- OpenRouter `Auto` is a zero-configuration coding profile, not an implicit
  provider-wide 4,096-token cap. For a request whose reasoning is OFF the
  shared contract resolves the output limit as `min(model max completion,
  32,000)` when live/static model metadata publishes a maximum, and 32,000
  otherwise, matching OpenCode's coding ceiling. When reasoning metadata says
  reasoning is enabled by default, the
  Auto effort is DECLARED, never inferred (BST-833): `reasoning.autoEffort`
  from our catalog if recorded, else the vendor's `defaultEffort`. With neither
  declared, Auto sends NO effort and the provider applies its own default —
  inventing one would be a silent fallback.
  Do NOT reintroduce the old rule, which scanned `supportedEfforts` for a
  "completion-biased" effort (`minimal`/`low`) and substituted `none` when it
  found none. That discarded the model's own declared default invisibly:
  GLM-5.2 declares `defaultEffort: 'high'` and advertises no low tier, so it
  lost reasoning entirely — for a reason unrelated to any measured budget risk,
  and with nothing surfaced to the user.
  A model that must reason less under Auto records `autoEffort` in the catalog
  (`'none'` switches it off deliberately and greppably) — `moonshotai/kimi-k3`
  does exactly this, because its `max` vendor default spends the whole output
  budget reasoning. Recording a fact we cannot get from OpenRouter is preferred
  over deriving it.
  The output window is NOT independent of effort (BST-1170, retiring the
  BST-833 assumption): OpenRouter documents that reasoning tokens ARE output
  tokens and that a requested effort allocates a share OF `max_tokens` for
  reasoning (high ≈ 80%, max/xhigh ≈ 95%, low ≈ 20%), so a fixed 32K ceiling
  on a reasoning run shrinks the whole thinking+answer window — Kimi K3 at
  explicit `high` thought for minutes and died at `finishReason: length`. A
  model whose vendor documents a completion window sized for always-on
  thinking records it as catalog-only `reasoning.vendorDefaultOutputTokens`
  (Kimi K3: 131,072 per the official K3 quickstart, verified 2026-08-05;
  OpenRouter publishes no max completion for that route). Whenever the request
  actually reasons — explicit effort, or the model's declared Auto/default
  resolution — `resolveOpenRouterOutputWindow` sends that window (capped by a
  declared model max completion); reasoning-off requests and models without
  the recorded fact keep the coding ceiling. The window is a truncation cap,
  not a spend target. The fact is recorded from vendor docs only — GLM-5.2
  documents no default window, so it deliberately has none. All three
  resolution sites share the rule: `buildEffectiveModelSettings` (app-shell),
  `resolveOpenRouterMetadataDisabledReason`'s input-budget reservation, and
  the agent-side `modelSettings` backstop in
  `packages/agent/src/mastra/agent-streaming.ts`.
  OpenRouter effort is a provider
  hint, not a deterministic reservation. The resolved output value drives both
  Mastra `modelSettings` and the input-context reservation. Explicit reasoning
  choices remain authoritative, and output values above a known model maximum
  are surfaced rather than silently clamped.
  The model menu and the per-thread provider-options builder must use the same
  resolved live metadata snapshot. It is invalid for the menu to offer an
  effort from live OpenRouter metadata and then validate that selection against
  a stale static catalog while composing the thread draft.
- A newly readable OpenRouter configuration must be usable without visiting
  model settings. When the DB-backed OpenRouter catalog is untouched, app-shell
  enables the small `OPENROUTER_RECOMMENDED_CODING_MODEL_IDS` set (balanced
  GPT-5.6 Terra, long-horizon Kimi K3, Qwen3.7 Max, GLM 5.2, and MiniMax M3) in
  one durable write. GLM 5.2 exposes only OpenRouter's documented `high` and
  `xhigh` reasoning efforts. MiniMax M3 is multimodal, so its static and
  persisted catalog declarations both enable image input.
  The database model registry remains the picker source of truth. Any existing
  enabled model, or any row whose `updated_at` is later than `created_at`, is an
  explicit prior choice—including an intentional all-disabled choice—and must
  be preserved exactly. Catalog migrations therefore continue preserving both
  `is_enabled` and the timestamps on existing rows. Key replacement, reload,
  and catalog refresh never reapply defaults; an unreadable key never triggers
  initialization. Missing recommended catalog rows or failed persistence are
  surfaced visibly rather than enabling a partial set or falling back to the
  whole OpenRouter catalog. Hosted fixed-provider runtimes do not run this
  desktop/local configuration initializer.
- OpenAI hosted `tool_search` response history has a narrowed provider-boundary
  seam in `openai-tool-search-history-compat.ts`. **Its recorded removal
  condition — "remove the seam after consuming an AI SDK release containing
  vercel/ai#17667" — was unsatisfiable as written and is retired (BST-1310).**
  That PR was closed UNMERGED on 2026-07-22 when its issue (vercel/ai#17666) was
  resolved by other means, so no release will ever "contain" it. The behaviour it
  described shipped instead in `@ai-sdk/openai` 4.0.18 (changeset `bc43dc2`,
  "Preserve stored tool search output item IDs from provider metadata"), which
  #2462 consumed at 4.0.42. Measured, not inferred from the version jump: the
  same persisted prompt serializes as two identical `tsc_` item references on
  4.0.8 and as distinct `tsc_`/`tso_` references on 4.0.42.
  The RESULT half of the seam is therefore gone. Two things remain, and neither
  is what #17667 was about. (a) The CALL is still canonicalized: Mastra v2
  persists a completed provider tool as one invocation and hydrates the result's
  provider metadata onto the call as well, so the call advertises the `tso_`
  OUTPUT id — and the responses converter trusts
  `providerMetadata.openai.itemId` on a `tool-call` part in 4.0.8 and 4.0.42
  alike, which collapses the call and the output into one `item_reference`. That
  is a Mastra persistence defect, not an AI SDK one; it has NO upstream
  version-based removal condition, so do not attach one. (b) The output's item
  reference is asserted DISTINCT from its call's, not merely present. The
  failure guarded against is duplication, and two routes reach it: output
  history carrying no item ID at all (the converter's last resort is
  `?? part.toolCallId`, a silent fallback that emits the call's id as the
  output's), and an output whose recorded ID already IS the call's — the
  SYMMETRIC form of the same Mastra hydration behind (a), landing the call's
  `tsc_` on the result. The second is the quiet one: nothing is absent and the
  two recorded IDs agree with each other, so a presence check waves it through
  and OpenAI 400s far downstream. Measured against the installed SDK rather than
  reasoned about — that prompt serializes as two identical `tsc_` references.
  Do NOT weaken this back to an existence check. The processor still runs
  OpenAI-only, and still never mutates durable history. Do not replace either
  half with `patchedDependencies` or a lossy history filter.
  The condition is now self-detecting rather than doc-resident:
  `openai-tool-search-history-compat.spec.ts` asserts ALL THREE upstream
  behaviours directly against the installed SDK — the preserved output ID, the
  call-side collision, and the symmetric output-side collision — so the release
  that fixes the remaining defect turns a test red instead of waiting for
  someone to re-read this page. Only the CALL half rewrites anything now, which
  is why the seam's one log line counts "call item references".
- OpenAI Responses item-id uniqueness has a second provider-boundary seam,
  `openai-duplicate-item-compat.ts` (BST-1095): when durable history holds the
  same assistant response under two message ids (Mastra sealed-boundary re-key
  double-persistence), the OpenAI-only `processLLMRequest` processor drops the
  stale duplicated `rs_`/`fc_`/`call_` references from the transient prompt so
  the request no longer 400s with "Duplicate item found" — keeping the result
  structurally valid: reasoning/text ids keep their newest occurrence, tool
  call+output survive as the newest complete pair (covering assistant-carried
  provider-executed results, e.g. native web search), and orphaned trailing
  reasoning in edited messages is swept. Within-message repeats (multi-summary
  reasoning) are untouched; durable history is never mutated. See
  `docs/agents/assistant-runtime.md` for its position in the input-processor
  chain.
- **AI SDK dependency-closure facts, recorded at #2462 (BST-1310).** Two things
  changed under the provider bumps that the version lines did not show.
  **`undici@7.28.0` is now in the agent's runtime closure.**
  `@ai-sdk/provider-utils` added it between 5.0.5 and 5.0.27, so the path
  `packages/agent` → `@ai-sdk/{anthropic,google,openai}` →
  `@ai-sdk/provider-utils@5.0.27` → `undici@7.28.0` is a plain transitive
  runtime dependency now — a full Node HTTP stack (`node:net`, `node:http`,
  `node:stream`, and the native WASM llhttp parser). That is fine on the Node
  side and must stay off the browser side, which is R2 in
  `docs/agents/mastra-boundary.md`. Verified rather than assumed: `apps/web` and
  `apps/desktop` alias only the five browser-safe agent subpaths listed in
  `packages/agent/config/browser-safe-subpath-aliases.mjs` (`/client`,
  `/local-llm`, `/pglite-mastra-memory/schema`, `/provider-metadata`,
  `/tool-metadata`), and none of those five imports `@ai-sdk/*`, `undici`, or a
  `node:` builtin. Keep it that way — a browser-safe subpath that reaches an
  `@ai-sdk` module now drags a Node HTTP stack into the renderer bundle.
  **The v4 `@ai-sdk/provider` line still has TWO copies, not one.** 4.0.7 (the
  `packages/agent` pin, the three providers, and
  `@ai-sdk/provider-utils@5.0.27`) and 4.0.4 (`@mastra/core@1.57.0`'s
  `@ai-sdk/provider-v7` alias, via `@ai-sdk/provider-utils@5.0.13`). What #2462
  removed was the agent-only THIRD revision — 4.0.2, which the old
  `provider-utils@5.0.5` pulled in — and that third copy was the actual hazard,
  because it split the provider types the agent itself compiles against. The
  remaining 4.0.4 lives entirely inside Mastra's aliased sub-tree and is not a
  regression to chase.
- OpenRouter reasoning controls are model-capability-aware when the Models API
  publishes its `reasoning` object. Selected-model metadata validates and
  preserves `mandatory`, `default_enabled`, `supported_efforts`,
  `default_effort`, and `supports_max_tokens`; absence is never guessed as
  support. Declare those efforts on the static
  model definition; `resolveReasoningControlsAvailability` in
  packages/assistant-contract/src/model-reasoning.ts is the single resolver
  that filters the UI controls (the composer ComposerEffortControl slider) to
  the declared set, and the request boundary rejects incompatible settings at
  construction. Matching live metadata overrides the static entry for both
  controls and request construction. Optional models expose Off even when
  `none` is not an advertised effort, using `reasoning.enabled=false`. Its
  sibling `resolveModelReasoningSupport` is deliberately
  separate: an UNDECLARED OpenRouter model keeps the full effort list for the
  controls (the request boundary accepts `openrouter.reasoning` for any model)
  while its capability badge resolves to a visible `unknown` ("unverified") —
  never a silent yes/no. On an explicit model switch, clear an incompatible
  provider-wide effort override so the newly selected model uses its documented
  default; do not map it to a guessed nearest level.
- Reasoning-control placement: effort/level selection and the primary Thinking
  toggle live in the always-visible ComposerEffortControl chip beside the
  model picker in the composer control dock (packages/ui/src/
  packages/assistant-ui/src/composer-effort-control.tsx, backed by
  reasoning-effort-controls.tsx). The chip's trigger doubles as the readout
  ("Effort High" / "Thinking Off") so the active reasoning config is legible
  without opening anything (BST-948); the model menu itself is selection-only.
  The Controls menu's provider section is now "Output & Limits" (formerly
  "Reasoning & Output") and keeps only agent runtime limits, max output,
  the shared "Reasoning output" summary control, the Anthropic numeric thinking budget, and the
  Google include-thoughts debug toggle. Moved controls must emit
  byte-identical settings updates to the old panel sections (pinned by
  write-through tests in composer-effort-control.test.tsx).
- Static OpenRouter prices are estimates for pre-existing/unreported usage.
  Exact provider-reported cost is authoritative because routing, caching, BYOK,
  and provider tiers can make the catalog rate differ from the billed amount.
  Run-step metadata may additionally retain the bounded selected upstream
  provider name and reasoning-token count exposed by Mastra's official
  `providerMetadata.openrouter` shape, plus the non-negative first-text latency.
  Never log or persist reasoning content.
- The OpenRouter `Auto` output profile is sent explicitly because Mastra's
  provider otherwise expands an omitted limit to the model's full output
  ceiling, which can make OpenRouter reject even a tiny prompt during credit
  preflight. The automatic input-token budget MUST reserve the same resolved
  coding default (or the explicit configured output limit), not the model's
  full output ceiling. The Output & Limits panel
  shows the selected model's context/output metadata, the effective reservation,
  and the resulting input budget. Desktop selected models install a validated
  live OpenRouter snapshot for budgeting and label its `live`, `fresh-cache`, or
  `stale-cache` provenance; loading and failed lookups keep the built-in catalog
  visibly labeled, with the failure shown instead of silently falling back. An
  unknown OpenRouter model surfaces unavailable limits instead of guessing. An
  explicit model switch clears a provider-wide output
  override that exceeds the newly selected model's declared maximum; it never
  carries a hidden incompatible limit or silently clamps it. Explicit compatible
  user limits remain authoritative. While editing the numeric output field, an
  empty, fractional, below-minimum, or above-maximum value remains visible as an
  uncommitted draft with an inline error and disables send until corrected; it
  is never clamped or persisted. The range slider remains bounded to the known
  model limits.
- OpenRouter's canonical token-limit errors (`context_length_exceeded`,
  `max_tokens_exceeded`, and `token_limit_exceeded`) remain typed through the
  stream boundary. The visible bounded failure includes the canonical type.
  Every provider shares the adjacent forensic envelope:
  `run.failed.metadata.runError` contains only stable `code`, bounded `message`
  and `causeChain`, validated `httpStatus`, bounded `providerRequestId`, and a
  literal allowlist of rate-limit / retry-after / request-id response headers.
  Header extraction reads only the AI SDK `responseHeaders` field or an
  explicitly nested `response.headers` object; an unqualified top-level
  `headers` bag is treated as request metadata and ignored.
  Unknown or provider-private codes resolve to
  `mastra_agent_stream_provider_error` when the error carries provider evidence
  (httpStatus, providerRequestId, allowlisted response headers, or an AI SDK
  api-call error marker: `AI_APICallError`/`AI_RetryError` name or
  `url` + `requestBodyValues`) and to `mastra_agent_stream_local_error` when it
  carries none; an arbitrary upstream `provider_code` is never persisted.
  Neither fallback code is ever prefixed onto the visible OpenRouter detail —
  only stable typed codes are. Request/response bodies, request headers, URLs,
  secrets, generic provider metadata, and retry-attempt data are excluded
  rather than
  sanitized after the fact. Consumers use the exported
  `readProviderRunError`/`isProviderRunError` boundary instead of shape-guessing
  event metadata.
- Desktop exposes `GET /assistant/openrouter-model?model=<provider/model>` for
  selected-model metadata. It resolves the stored OpenRouter key in main,
  requests the official single-model endpoint, validates exact model identity,
  positive context/output limits, bounded supported parameters, and the full
  published reasoning-capability object, and keeps a bounded five-minute
  in-memory cache. A refresh failure may return a prior
  snapshot only as explicit `stale-cache` data with a warning; a first failure
  is a visible 502. The renderer validates the assistant-server snapshot before
  using it for the selected model's context meter, derived input budget, and
  output control maximum. A configured output limit above the live maximum, or
  an input limit above the derived live effective budget, disables send with an
  explicit correction message. Validation uses the effective request setting,
  including a Prompt Workbench draft `modelSettings.maxOutputTokens` override.
  An impossible persisted output reservation keeps the settings panel available
  for repair instead of throwing during render; the endpoint never silently
  mutates the registry.
  Qwen3.8 Flash's fixed `qwen/qwen3.8-flash` route is a documented exception to
  treating the Models API budgets as independently authoritative: aggregate
  metadata can advertise wider limits than this route's 1,000,000-token context
  and 131,072-token output ceilings. `mergeCatalogBudgetCeilings` therefore
  clamps this exact route's live context to the static catalog ceiling and its
  output to the minimum of the live output when present, the catalog output, and
  the merged context. The final context cap keeps a missing live output value
  from producing an invalid snapshot whose output exceeds context. Do not apply
  this route-specific rule to every catalog model without equivalent fixed-route
  evidence; other static entries remain fallbacks that live metadata may refine.
  The static Qwen3.8 Flash definition also records its exact text/image/video
  input and text output modalities; `vision` remains the separate image-gating
  projection. Paired coverage:
  `apps/desktop/src/__tests__/assistant-server/openrouter-model-metadata.test.ts`
  and
  `packages/assistant-contract/src/__tests__/provider-registry-frontier-models.test.ts`.
- State:
  - packages/app-state/src/stores/assistant-preferences-store.ts
  - packages/assistant-data/src/assistant-thread-store.ts
  - Assistant preferences persist the most recently selected model as the default for the next
    new thread, plus a capped `recentModels` list (composite keys, newest first) that feeds the
    composer model menu's top-level rows. The thread store persists each existing thread's model and provider settings so
    switching chats or restarting the app restores that thread-specific runtime.

Assistant status endpoint resolution (in order):
1. window.assistant.getUrl()  (async)
2. window.assistant.url       (static)
3. /api/assistant/status      (fallback)

An enabled Hosted Web status response advertises its trusted primary runtime
pair plus every configured provider:
`{enabled:true,provider:<first configured>,model:<registry default>,providers:[...],providerKeySources:[...]}`.
The stable provider priority is OpenAI, Anthropic, Google, then OpenRouter. The
server and app shell consume the same provider registry: the shell validates the
primary pair, provider list, and environment provenance, skips renderer-side key
discovery, and derives each secondary provider's fixed registry-default model.
The primary pair remains atomic; a provider without a registry default, or any
incomplete, unknown, duplicate, or inconsistent metadata, fails visibly.
Desktop status may omit the pair, in which case its encrypted-key discovery
remains authoritative.

Desktop's non-fixed `providers` list is a validated seed, not an exhaustive
renderer catalog. The app shell must merge it with renderer provider discovery
so settings-owned, reachable or force-enabled Ollama and LM Studio runtimes
remain selectable. Hosted Web's fixed provider/default-model set stays
authoritative and must continue to skip renderer discovery.
`AssistantProviderSource`, provided at the `AssistantChatPanel` composition root,
is the required explicit boundary: a missing provider throws. `authoritative`
is derived synchronously during render, while `discovery` subscribes one shared
external resource to the secrets-store revision and the immutable Ollama / LM
Studio provider-settings snapshots. Unrelated provider settings never trigger
keychain enumeration or local-runtime probes. The first Desktop subscriber
starts discovery and the last subscriber tears down the live subscriptions, so
multiple mounted thread tabs never fan out duplicate runtime probes. The last
visible provider snapshot remains cached across a zero-subscriber period and is
rendered while the next subscriber revalidates; only the test reset clears it.
Every refresh carries a monotonically increasing generation; a superseded or
unsubscribed request cannot publish late. Unexpected key or runtime discovery
failures remain visible as a panel notice while explicit Desktop seeds stay
rendered; they are never converted to an empty successful result. The notice
blocks the composer only when the merged snapshot contains no usable provider.
A partial failure must not disable an independently verified or validated-seed
provider.
Ollama and LM Studio probes settle independently. If one unexpected probe
fails, every independently verified provider remains in the error snapshot and
the failed probe remains visible through the typed aggregate error; neither the
successful provider nor the failure may be discarded. Malformed main-process
bridge payloads use that same visible failure channel.
Idle and loading snapshots pause persisted-model reconciliation. Error snapshots
do not: their independently verified or last-known provider list remains the
selection authority while the error stays visible, so a failed sibling probe
cannot leave a disappeared provider selected forever.
Keep the authority, refresh, ordering, teardown, and failure controls in
`use-configured-assistant-providers.test.tsx` when this boundary changes.

**The reconcile itself is a pure decision, not an effect (BST-1652).**
`packages/app-shell/src/assistant-panel/model-selection-reconcile.ts` takes a
plain input snapshot and returns one `{kind: 'keep' | 'select' | 'clear'; reason}`
value; `use-model-selection-reconcile.ts` is the only thing that applies it and
holds no policy of its own. Branch ORDER is load-bearing — built-in-local
seeding, then the discovery pause above, then provider availability, then the
local-runtime leg, then registry re-selection — and every branch has a named
reason with a unit test in `assistant-panel/__tests__/`, so a new case belongs
in the pure module (testable without React or PGlite) rather than in the hook.
A `select`/`clear` is logged at debug with its reason; `keep` is the steady
state and is not logged. The mount-level oracle stays
`assistant-ui-panel-wrapper-provider-seeds.test.tsx`.

One deliberate wart is preserved and pinned: built-in-local seeding is gated on
the RENDER-captured selection (`renderedSelectedModel`) while every other branch
reads the live store, exactly as the pre-extraction effect did. Collapsing the
two is a separate, deliberate change — not a cleanup to fold into an unrelated
edit.

The mounted assistant wrapper keys local-runtime status and model-catalog
refreshes to the immutable Ollama / LM Studio settings snapshots; unrelated
provider settings do not trigger local probes. Changing activation, base URL,
or credentials invalidates both requests. Status is resolved before catalog
loading, and the combined refresh uses a monotonically increasing generation
so a response from an older settings snapshot cannot replace the new catalog.

Desktop status also reports each unreadable stored credential as a validated
`providerErrors` entry (`provider`, `api_key_unreadable`, typed error code, and
the safe repair message). One unreadable credential never hides other working
providers. The shared shell preserves these entries and disables only the
selected affected provider with the re-entry guidance; malformed or duplicate
entries fail the availability probe instead of being guessed at. An environment
credential remains authoritative and suppresses a stale stored-key read failure
for that provider.

Desktop status keeps keyless runtime availability in `providers` and reports
credential provenance separately in `providerKeySources`. Each entry is exactly
either `{provider,source:"stored"}` or
`{provider,source:"env",envVar:<declared name>}`; values never cross HTTP or IPC.
The renderer rejects duplicate providers, unknown sources, extra fields, and an
environment-variable name not declared for that provider. `secrets:list`
returns the same source metadata (including Tavily), while
`secrets:listStored` remains the keychain-only string list. Test-mode Secrets
IPC remains environment-blind. Settings merges status provenance with IPC
metadata so an injected test/launch credential is visible without weakening
that hermetic IPC boundary, and disables an inert Save action while an
environment key is authoritative.

An invalid desktop environment file leaves the assistant server reachable but
makes `/assistant/status` return the typed
`assistant_configuration_invalid` state with only safe logical-file failure
metadata and no partial provider availability. The shared status validator
maps that payload to a visible error state; it never falls back to stored keys.

Implementation:
- packages/app-shell/src/hooks/use-assistant-availability.ts

When changing this flow, update this doc.

### Provider catalog data ownership (BST-1650)

The per-provider and per-model VALUES no longer live in
`provider-registry.ts`. Ownership is split, and editing the wrong half is the
common mistake:

| File | Owns |
| --- | --- |
| `packages/assistant-contract/src/provider-catalog.json` | Every provider and model ROW: `displayName`, `authType`, `envKeys`, `deprecatedEnvKeys`, `docsUrl`, `keyFormatHint`, `keyNotes`, `capabilities`, `runtime`, and each model's `id`/`type`/`label`/`contextWindow`/`vision`/`supportsStreaming`/`defaultDimension`/`tagline`. |
| `packages/assistant-contract/src/provider-catalog-schema.ts` | The runtime validation of those rows (`parseProviderCatalog`), plus the `Parsed*` inferred types the drift test compares against the interfaces. |
| `packages/assistant-contract/src/provider-registry.ts` | The `ProviderDefinition` / `LlmModelDefinition` / `EmbeddingModelDefinition` TYPES and the accessors (`getProviderDefinition`, `findProviderDefinition`, `providerAuthType`, `findLlmModelDefinition`, …). Its `PROVIDER_DEFINITIONS` is now the parsed JSON, not a literal. |

The schema is a REQUIRED boundary, not a convenience:

- `resolveJsonModule` widens JSON literals (`"llm"` becomes `string`), so `tsc`
  no longer checks catalog rows. `parseProviderCatalog` does, once at module
  load, and THROWS with the offending `provider.model.field` path. There is no
  partial-catalog mode (repo rule: NO SILENT FALLBACKS).
- Every object is a Zod `strictObject`. A misspelled optional key used to be an
  excess-property compile error; without `strict` it would now be silently
  dropped. `_note` is the one non-runtime key (it replaces the source comments
  JSON cannot hold) and `parseProviderCatalog` strips it before any consumer
  sees a definition.
- **Adding, removing, or retyping a catalog field means editing the schema AND
  the interface in the SAME change.**
  `packages/assistant-contract/src/__tests__/provider-catalog-schema.test.ts`
  asserts mutual assignability between `CatalogShape<z.infer<…>>` and each
  interface, so one-sided drift is a type-check failure rather than a runtime
  surprise. A field added only to the interface never validates; a field added
  only to the schema is invisible to consumers.

**Catalog object keys are alphabetical at every depth, and that is enforced.**
`biome.json` re-includes this one path from the blanket `!**/*.json`, so the
file is formatted — but Biome's `useSortedKeys` assist does not reach JSON
object keys, so `findCatalogKeyOrderFailures` in
`scripts/model-catalog-migration-contract.mjs` enforces the order instead
(`pnpm lint:model-catalog-migrations`, already a CI lint). A wrong order FAILS
naming the entry; nothing is reordered for you, because a silent reorder of a
data file is an invisible change to the rows a reviewer is reading. ROW order
is deliberately unchecked: providers and models are curated (`gpt-5.6-sol`
before `gpt-5.6-terra`, `claude-opus-5` before `claude-sonnet-5`) and no
comparator derives that.

Scripts read the JSON directly rather than through the package —
`scripts/model-catalog-migration-contract.mjs`,
`scripts/gen-model-catalog-migration.mjs`, and
`scripts/__tests__/provider-env-keys-mirror-contract.test.mjs`. That is the
point of the move; do not reintroduce an AST walk over a TypeScript literal
(the BST-1143 "keep `PROVIDER_DEFINITIONS` a static array literal" rule is
retired). The DB `models` mirroring rules stay in
`docs/agents/database.md` (model catalog section).

#### Model pricing is per-ROUTE, not per-model (BST-1698)

Each row's `pricing` is declared from the source that BILLS that route: a
first-party `openai` row from developers.openai.com, an `openrouter/*` row
from OpenRouter's live Models API (`https://openrouter.ai/api/v1/models`,
whose per-token decimal strings are x 1e6 to reach $/MTok). Two rows for the
same underlying model may therefore carry DIFFERENT rates, and a divergence
between a direct row and its OpenRouter twin is EXPECTED DATA, not drift —
do not "fix" one row to match the other.

The live instance: `gpt-5.6-sol` is 4/20 $/MTok on the `openai` row and 2/10
on `openai/gpt-5.6-sol` (both retrieved 2026-09-08). The divergence is
Sol-specific, and the evidence for that is LIVE-vs-LIVE, not our own rows: on
2026-09-09 the OpenRouter Models API and developers.openai.com agree exactly
on every sibling checked — terra 2/12, luna 0.2/1.2, gpt-5.5 5/30,
gpt-6-astra 10/50 — so OpenRouter is a faithful pass-through and only Sol
(2/10 vs 4/20) departs. Do NOT argue this from two catalog rows agreeing with
each other: the `openai` block's terra, luna and gpt-5.5 rows are stale and
agree only because they were copied from one stale source (BST-1705 re-priced
the `openrouter` block; the direct `openai` rows still carry the old figures
and need their own pass against developers.openai.com).
It is recorded rather than resolved: OpenRouter is the route that bills the
user, provider-reported billed cost stays authoritative at runtime, and a
declared rate is a display estimate.
`packages/assistant-contract/src/__tests__/provider-registry-pricing.test.ts`
pins both rows AND asserts they differ, so a sweep that mirrors them fails.

**What BST-1705 settled about Sol, and what it did NOT.** SETTLED: the 4/15
figure that sits beside OpenRouter's 2/10 is a declared `min_prompt_tokens:
272000` LONG-CONTEXT TIER in the route's `pricing.overrides` — not a
time-of-day surge band, and not an anomaly. 2/10 is what the route charges an
ordinary prompt and 4/15 is what it charges above 272K input tokens; our
one-rate-pair schema carries the base and drops the tier (BST-1708 owns
modelling tiers), so 2/10 is the right number to hold for THIS route under
the per-ROUTE rule above.

NOT SETTLED, and do not read this section as if it were: **why the gateway
says 2/10 where developers.openai.com says 4/20**. The tier explains what
4/15 IS; it does not reconcile that gap, which is the thing the older caveat
flagged. The tier arguably makes the alternative reading STRONGER, not
weaker — OpenRouter's long-context input rate is 4 and the direct row's
disputed figure is 4/20, which is as consistent with "the direct Sol row was
read off OpenAI's >=272K tier" as with "Sol genuinely diverges". So the row
`_note` on `openrouter/openai/gpt-5.6-sol` still says the divergence MAY be
an upstream data error, and that stands: re-read both sources during the
`openai`-block pass (the same pass that owes terra, luna and gpt-5.5 their
own re-pricing) rather than treating either row as settled here. What the
pin in `provider-registry-pricing.test.ts` asserts is only that the two rows
DIFFER and are sourced separately — not that 2/10-vs-4/20 has been explained.

#### Read the BASE rate, not the rate in force right now (BST-1705)

`pricing.prompt` / `pricing.completion` are the rate AT READ TIME. Two kinds
of `pricing.overrides` entry move them, and both have already put a wrong
number in the catalog:

| override key | meaning | trap |
| --- | --- | --- |
| `min_prompt_tokens` | long-context tier (63 live routes) | a size surcharge this schema does not carry (BST-1708) |
| `utc_days` / `utc_start` / `utc_end` | time-of-day SURGE band (2 live routes) | inside a peak window the top-level rate IS the surge rate |

Those are the only two shapes, and the audit recognises each by POSITIVE
evidence: of the 65 live routes carrying `pricing.overrides` on 2026-09-10,
63 are `min_prompt_tokens` tiers, 2 are clock bands, and 0 are anything else.
An entry matching neither — or mixing both — throws. Classifying by
elimination is fail-open here, because the band reader defaults every absent
UTC field: an unrecognised entry would become a band covering the whole week
and could then WIN the cheapest-band comparison and become the recorded base
rate. A third shape gets read by a human and taught to the script.

`tencent/hy3` shipped at 0.132 / 0.528 — its 00:00-16:00 UTC band — because
BST-1696 read the API during that window. Nothing in the response says so:
the base 0.0825 / 0.33 is only visible in `overrides`. A third trap needs no
overrides at all — `<id>:batch`, `<id>:free` and `<id>:nitro` are SEPARATE
routes with their own prices, and `google/gemini-3.7-flash` and
`z-ai/glm-5.3-flash` both shipped carrying their `:batch` twin's rate.

So: record the standard route's base rate. On a route with clock bands that
means THE CHEAPEST BAND, not "the rate outside every band" — a payload whose
bands leave part of the week uncovered is rejected outright, so there is no
outside, and it is not "the band covering most of the week" either, because
`tencent/hy3` surges for 16 hours in every 24 and its modal band IS the surge.
The known limit of the cheapest-band rule is a promotional window priced BELOW
the standing rate, which would be read as the base; nothing live does that
(2026-09-10) and the payload carries no field separating a discount window
from a surge window, so the rule stands and the limit is recorded rather than
guessed around. `scripts/openrouter-pricing-audit.mjs` derives it
(time-independently, failing closed on any shape it does not recognise) and
diffs the whole `openrouter` block against the live API:
`pnpm run audit:openrouter-pricing`. Run it when adding or re-pricing a row.
It is deliberately NOT part of `lint:ci` — the fact lives upstream and
OpenRouter re-prices roughly weekly, so a network gate would fail PRs for
reasons outside them, and skipping it on a network error would be exactly the
silent degradation this repo forbids. What IS in the required Static lane is
`scripts/__tests__/openrouter-pricing-audit.test.mjs`, which pins the
derivation offline against real payload shapes — including the same surge
payload captured at a peak and an off-peak moment, which must yield the same
answer.

### Provider registry auth metadata (BST-1349)

`ProviderDefinition` in
`packages/assistant-contract/src/provider-registry.ts` types the per-provider
auth metadata and `provider-catalog.json` carries the values (BST-1650, above);
that pair is the ONLY source for it:

- `authType: 'api_key' | 'oauth_subscription' | 'aws' | 'none'` — REQUIRED on
  every provider. `'none'` marks the keyless providers (`local`, `ollama`,
  `lmstudio`); the local servers' optional bearer token is a TRANSPORT concern
  (`providerOptions.apiToken`, registry `runtime: 'local'`), not an authType.
  `'aws'` is carried by `bedrock` (BST-1350/BST-1353; ONE authType covers both
  auth forms — the stored credential's `mode` discriminates bearer from
  profile chain). `'oauth_subscription'` is carried by `openai-codex`
  (BST-1356 — ChatGPT-subscription sign-in; see the Codex section below).
  Keyless-ness DERIVES from `authType === 'none'` and NEVER from "declares no
  env keys": `openai-codex` declares `envKeys: []` precisely BECAUSE it is
  interactive OAuth only, and conflating the two would advertise it as usable
  before the user has connected an account.
- `docsUrl?` — the provider's "get an API key" page (required in practice for
  `api_key` providers).
- `keyFormatHint?` — vendor-documented stable key prefix (e.g. `sk-ant-...`).
  Omit when the vendor documents no stable format; never guess.
- `keyNotes?` — provider-specific key guidance rendered verbatim in Settings
  (e.g. google's Gemini-vs-Vertex note).

What DERIVES from the registry (via `providerAuthType(id)` /
`getProviderDefinition(id).runtime`; lookups on ids not statically typed
`ProviderId` use the non-throwing `findProviderDefinition` — an
out-of-registry id must reach a documented fallback, never a TypeError):

- `packages/agent`: `resolveRuntimeConfiguration` (keyless = `authType
  'none'`), `PERSONA_PIN_KEYLESS_PROVIDERS`, `isHostedProviderRuntime`
  (fail-open: only `runtime 'local'|'browser'` opt out of the hosted path),
  the dynamic local-model tool budget, and `createLanguageModelProvider`'s
  key requirement.
- `packages/assistant-service`: `providerAllowsMissingAuth`,
  `resolveCredentialOrReject` (BST-1352 name of the former
  `resolveApiKeyOrReject`; a keyless provider's OPTIONAL token read failure
  proceeds keyless with a warn, never a 400), local-runtime token hydration.
- `packages/assistant-contract`: `model-reasoning.ts`'s discovered-model
  answers key off registry `runtime: 'local'`.
- Settings renders `keyNotes`/`keyFormatHint`/`docsUrl` generically — no
  `provider === '...'` branches. `PROVIDER_COLOR_MAP` (`packages/ui`) is
  compile-time exhaustive over `SupportedProvider` (`satisfies`); its hash
  fallback serves only dynamically discovered runtime ids.

KNOWN remaining hand-sites (deliberate or ticketed — do not silently grow
this list):

- `packages/app-shell` `LOCAL_RUNTIME_PROVIDER_IDS` and the settings-ui
  embedding section's local-runtime entries — follow-up in BST-1362/BST-1358
  (Provider Hub) scope.
- `packages/embeddings` / `packages/indexing-contract` embedding-provider
  key tables — BST-1361.
- `apps/desktop/src/assistant-server/provider-credentials.ts` (~line 48)
  availability semantics: only `local` is unconditionally available;
  local-server availability is probed. Deliberate, documented here.
- Transport/display concerns are NOT authType sites and stay per-provider:
  the `providerOptions.ollama`/`.lmstudio` namespace stripping, local-runtime
  factory type unions, and human display labels.

Pinned by
`packages/assistant-contract/src/__tests__/provider-registry-auth.test.ts`,
`packages/agent/src/__tests__/runtime-configuration.spec.ts`,
`packages/agent/src/__tests__/tool-output-limits.spec.ts` (unknown-provider
fallback), `packages/agent/src/__tests__/tool-pipeline-provider-runtime.spec.ts`,
the BST-1349 suites in
`packages/assistant-service/src/__tests__/request.test.ts`, and the
`satisfies` in `packages/ui/src/model-picker/utils/provider-colors.ts`.

### Provider credential seam (BST-1352)

The credential path is TYPED end to end; the bearer-key string is now a
projection of it, not the contract. Three layers, each with one owner:

**Reader types** (`packages/assistant-service/src/ports.ts`, re-exported from
`/request`):

- `ResolvedProviderCredential = ProviderCredential & { source: 'env' | 'stored' }`
  — the BST-1348 union plus provenance. `source: 'env'` entries are ALWAYS
  `api_key` (environment variables can only express bearer keys); typed
  `oauth`/`aws` credentials only arrive `source: 'stored'`.
- `ProviderCredentialReader` — the typed reader `prepareAssistantPostRequest`
  consumes (`undefined` = not configured; a secret-read failure THROWS).
  Desktop passes `resolveProviderCredential`
  (`apps/desktop/src/assistant-server/provider-credentials.ts`), built on
  `readProviderCredential` (`apps/desktop/src/provider-api-key.ts`) →
  `resolveHostedProviderCredential`, the typed generalization of the BST-979
  env-authoritative core in
  `packages/assistant-contract/src/provider-key-resolution.ts` (same contract:
  env order, never throws, `secretReadError` pass-through only when nothing
  found; `SECRETS_CHANGED_EVENT_NAME` untouched). Hosted Web adapts its
  env-only config lookup into `api_key` credentials — no typed-credential
  resolution on web.
- `ProviderApiKeyReader` (string) is the MIGRATION SHIM, derived only via
  `createProviderApiKeyReader(typedReader)` in
  `assistant-service/src/provider-credential-projection.ts` (the projections
  live there, NOT in ports.ts — ports stays a structural surface):
  `api_key` → `.key`; any other type throws the SecretReadError-shaped
  `credential_type_unsupported` failure built from the SHARED
  `describeSecretReadError` text in assistant-contract (a structured
  credential is NEVER stringified). The credential-type narrow lives in ONE
  place per layer: `providerAuthInputFromCredential` here (the shim composes
  it), and the desktop store's `credentialToApiKey` keeps its own narrow
  deliberately (store-layer contract, real `SecretReadError` class).
  COMPLETE string-surface consumer list (the `@deprecated` shim's remaining
  call sites): persona pin key resolution (stream-init's
  `resolveProviderApiKey` injection), persistent-memory model targets
  (`apps/desktop/src/assistant-server/mastra-memory.ts` →
  `createLanguageModelProvider(provider, apiKey, …)`), and the desktop
  OpenRouter-metadata/status endpoints (`resolveProviderApiKeyOrRespond`).
  `ipc-agent.ts` is MIGRATED onto the typed core (`readProviderCredential`,
  typed degradation included). ACCEPTED LIMITATION: persistent memory and
  embeddings remain api_key-only until a ticket needs otherwise — Bedrock is
  excluded from persistent memory by
  `PERSISTENT_MEMORY_LANGUAGE_MODEL_PROVIDERS`, and oauth providers will not
  be memory providers. The request pipeline's credential-type narrow IS the
  shared projection since BST-1350 (`resolveCredentialOrReject` calls
  `providerAuthInputFromCredential`): a projectable credential yields its
  bearer surface (api_key keys, bedrock aws-bearer keys), and a
  non-projectable one (oauth, aws stored on a non-aws provider, and aws
  profile_chain on a host that supplies no chain capability) maps onto the
  SAME `api_key_unreadable` 400 (or the keyless optional-token warn) the old
  `getKey` throw produced — never `missing_api_key`. Since BST-1353
  `prepareAssistantPostRequest` takes an optional `awsCredentialChain` and
  forwards it verbatim to that projection, so PREPARATION classifies a
  profile_chain credential exactly as the host that will CONSUME it does:
  desktop supplies the builder and preparation succeeds keyless, Hosted Web
  omits it and preparation rejects. A profile_chain credential is therefore
  the SECOND legitimate "no apiKey" case beside keyless (`authType 'none'`)
  providers — it is configured, it simply carries no bearer string — and it
  must never fall into `missing_api_key`. Reaching that point means the
  projection already ACCEPTED the credential, so the keyless path can never
  wave through an unusable one.

**Factory auth input** (`packages/agent/src/providers/provider-auth-input.ts`):
`createProvider(provider, auth?: ProviderAuthInput, model?, runtime?)` takes a
discriminated union instead of a bare key string:

- `{ kind: 'api_key', apiKey }` — the existing flow; behavior-identical to the
  old string parameter. Every current caller uses this kind.
- `{ kind: 'custom_fetch', apiKey /* dummy */, fetch }` — threads the injected
  fetch into the AI SDK `create*` factories (`providerFetchOptions` helper).
  Consumed by BST-1356. Provider cases whose model config is a Mastra
  DESCRIPTOR (openrouter/ollama/lmstudio) or the local host client have no
  fetch seam and throw typed (`bearerApiKeyOnly`) — the fetch is never
  silently dropped. `wrapAnthropicModelWithPromptCaching` composes with every
  kind (pinned by `provider-factory.auth-input.spec.ts`). EVERY secondary SDK
  client shares the seam: the provider-native web-search client
  (`native-web-search.ts`) is built from the SAME ProviderAuthInput via
  `providerFetchOptions` — never from a bare key (pinned by
  `native-web-search.auth-input.spec.ts`; a bare-key client under
  custom_fetch would send the dummy key to the real API).
- `{ kind: 'aws', region, apiKey?, credentialProvider? }` — validated (region
  REQUIRED and format-checked, typed errors `MISSING_AWS_REGION_DETAIL` /
  `INVALID_AWS_REGION_DETAIL`; plus the BST-1353 EXACTLY-ONE rule below) and
  consumed ONLY by the `bedrock` case via `requireAwsAuthInput` (BST-1350);
  every other case throws typed. `credentialProvider` is the SigV4 consumer
  (BST-1353): it is TYPED, not `unknown`, through the import-free
  `providers/aws-credential-identity.ts` so this browser-reachable seam keeps
  ZERO edges — not even type-only — to the Node-only
  `@aws-sdk/credential-providers`. That declaration's fidelity is
  compile-checked, not asserted by comment: `createAwsCredentialChain`
  declares `AwsCredentialIdentityProvider` as its return type while returning
  the SDK's own `fromNodeProviderChain(...)` result, so drift is a red build
  at that return statement (the indirection exists because `@smithy/types` is
  transitive and does not resolve from `packages/agent`). Every switch over
  the union is exhaustive (compile error on an unhandled kind).
- **EXACTLY ONE aws credential (BST-1353, widening PR #2522 finding 4).** An
  `aws` input must carry `apiKey` XOR `credentialProvider`.
  `assertExactlyOneAwsCredential` enforces it inside
  `assertValidProviderAuthInput` (before provider dispatch, the same
  placement the region rules use) AND is RE-asserted in the factory's
  `bedrock` case, so a DIRECT `createProvider` caller cannot slip past the
  pre-dispatch validator. Neither form present →
  `MISSING_AWS_CREDENTIALS_DETAIL`: with both absent the AI SDK falls back to
  AMBIENT AWS environment credentials, quietly signing with whatever identity
  is in the process env. Both present → `CONFLICTING_AWS_CREDENTIALS_DETAIL`:
  the AI SDK prefers `apiKey` over `credentialProvider`, which is precisely
  why the XOR is ENFORCED rather than relied upon — bearer-vs-chain
  precedence is decided ONCE at credential resolution
  (`apps/desktop/src/provider-api-key.ts`), so a doubly-populated input
  reaching the factory means a resolver bug and is surfaced, not papered
  over. This constant REPLACES BST-1350's `MISSING_AWS_BEARER_KEY_DETAIL`.

**Threading rule (do not relitigate):** the auth input travels as a DIRECT
parameter the whole way down — `runAssistantTurn` → `initializeAgentStream` →
stream options (`toAiSdkStyleStream` / the approval + suspend resume actions)
→ `MastraAgentRuntimeOptions.authInput` → `resolveRuntimeConfiguration` →
`instantiateLanguageModel` → `createProvider`. Credentials/auth inputs NEVER
enter RuntimeData or a Mastra RequestContext: `RequestContext.toJSON` drops
functions, so a `custom_fetch` closure riding runtime data would vanish
silently. Since the BST-1352 review, stream-init builds the runtime object
WITHOUT an apiKey field and the desktop memory path's request-key reuse is
retired — the only remaining `runtime.apiKey` READ is key-resolver's
documented legacy surface for DIRECT `streamMastraAgent` callers that never
pass an authInput. `resolveRuntimeConfiguration` treats a threaded auth
input as AUTHORITATIVE (no fallback into runtime/env key resolution);
supplying BOTH `resolved` and a different `authInput` to
`createMastraAgentRuntime` throws typed (same-reference is the legitimate
pre-resolved path); `mastra_agent_missing_api_key` code + message are
unchanged, and `aws` inputs skip the bearer-key requirement. Hosted Web is a
PROJECTION of the prepared typed credential
(`providerAuthInputFromCredential` in `web-assistant-stream.ts`) — no string
re-mint, api_key-only enforcement stays at the web resolution layer.

Pinned by `packages/agent/src/__tests__/provider-factory.auth-input.spec.ts`,
the BST-1352 blocks in `runtime-configuration.spec.ts`,
`persona-pinned-model.spec.ts`,
`packages/assistant-service/src/__tests__/request.test.ts` +
`run-turn.test.ts`,
`packages/assistant-contract/src/__tests__/provider-key-resolution.test.ts`,
and `apps/desktop/src/__tests__/main/provider-credentials.test.ts` +
`provider-api-key.test.ts`.

### Credential-verification probes (BST-1357)

`apps/desktop/src/assistant-server/provider-verification.ts` (modeled on
`openrouter-model-metadata.ts`: bounded TTL cache with `live`/`fresh-cache`
provenance, single-flight per (provider, credential digest), 10s timeout, NO
retries) runs the cheapest authenticated call that proves a stored
credential. Only `verified`/`verified_limited` earn the 60s success TTL;
failure results cache for a separate 3s `failureTtlMs` (click-storm dedup
only — recovery must be observable on the next deliberate click), and the
cache timestamp is sampled AFTER the probe resolves so a 10s timeout does not
pre-burn its own TTL (#2519 review). Exposed as
`GET /assistant/verify-provider?provider=<id>` beside the OpenRouter metadata
endpoint (same origin/auth gates); the renderer sends ONLY the provider id —
credentials resolve main-side via the typed reader. Renderer seam:
`fetchProviderVerification` + the button-driven `verifyProviderCredential`
(`packages/app-shell/src/verify-provider-credential.ts`) — a plain async
FUNCTION, not a hook: settings-ui owns the probe UI but cannot import
app-shell (that would close a cycle), and a hook may not be passed as a value.
The React state around it lives in `use-provider-verification-state`
(`packages/settings-ui`). BST-1378 deleted the original `useProviderVerification`
hook, which lost its last consumer when BST-1358 moved that lifecycle into
settings-ui.
Wire contract: `ProviderVerificationSnapshot` in
`packages/assistant-contract/src/provider-verification.ts`.

| Provider | Probe |
| --- | --- |
| openai | `GET https://api.openai.com/v1/models` (Bearer) |
| anthropic | `GET https://api.anthropic.com/v1/models` (`x-api-key` + `anthropic-version: 2023-06-01`, the version the repo's `@ai-sdk/anthropic` sends) |
| google | `GET https://generativelanguage.googleapis.com/v1beta/models` — `x-goog-api-key` HEADER, never the documented `?key=` param (keys must not enter URLs/logs) |
| openrouter | `GET https://openrouter.ai/api/v1/key` (Bearer); success `detail` uses NUMERIC usage figures only — the payload's `label` is key material |
| cohere | `GET https://api.cohere.com/v1/models` (Bearer) |
| voyage | `POST https://api.voyageai.com/v1/embeddings` with a one-token body — Voyage publishes NO model-list GET (verified 2026-08-18), so the documented minimal call is the probe. NOTE: this is a METERED one-token embeddings call, unlike the GET probes |
| tavily | `GET https://api.tavily.com/usage` (Bearer). Not a chat provider (no registry entry); synthetic api_key target + its own keychain reader |
| authType `aws` (bearer) | `GET https://bedrock.<region>.amazonaws.com/foundation-models` (Bearer). Keyed by authType + credential shape, so it activates when BST-1350's bedrock provider lands; uses the same shared HTTP classifier as every other probe |
| authType `aws` (profile_chain) | CHAIN RESOLUTION itself (`verifyAwsCredentialChain`, BST-1353) — NOT an HTTP call. The chain IS the credential, so resolving it is the most direct possible proof, and it answers the question the user actually has ("is my SSO session still good?") before they spend a turn finding out. Injected like `fetchImpl` so tests drive every verdict without a real `~/.aws` |
| authType `none` | typed `not_applicable`, ZERO network calls and ZERO credential reads — local-runtime liveness is the ipc-runtime probe family's job |

Status semantics (do not blur them; ONE shared HTTP classifier module-wide,
#2519 review): `verified` = 2xx; `verified_limited` = the credential
authenticated but the probe could not fully succeed — 403
(permission-scoped, e.g. an InvokeModel-only bedrock key) or 429 (a VALID
key that is rate limited / out of quota; OpenAI answers 429
insufficient_quota on real keys) — both DISTINCT from 401; `invalid` = the
endpoint rejected the credential (401, or google's documented
`API_KEY_INVALID` 400); `unreachable` = no auth verdict obtainable (network
error, timeout, or any HTTP status outside the classified set — 404, 5xx, …)
— wrong-key vs wifi-down MUST stay distinct; `not_applicable` = nothing to
probe (authType `none` ONLY — aws profile_chain LEFT this bucket in BST-1353,
see below). Failure `detail` derives from
the HTTP status ONLY (bodies can echo request headers); an api_key provider
WITHOUT a declared probe throws — never a guessed endpoint — and the
probe-coverage contract test (iterating registry `api_key` providers against
the probe table, plus tavily) turns "new provider ships unverifiable" into a
red build.

The profile-chain probe (BST-1353) maps chain outcomes onto those SAME
semantics without inventing a status: resolved → **`verified_limited`**, NOT
`verified` (PR #2525 review, finding 5 — chain resolution proves only that
LOCAL credentials exist and never touches Bedrock, so reporting `verified`
would silently redefine that status for one provider; the detail reads
"…profile chain; Bedrock access not exercised", the same rung a 403 earns);
`sso_expired` or `no_credentials` → `invalid`, because both mean exactly "this
credential will not authenticate"; an unrecognized SDK failure (`kind:
'unknown'` — a DNS error during an SSO refresh, say) → `unreachable`,
preserving "no verdict obtainable". The failure `detail` is the classifier's
actionable guidance, so an expired session shows the `aws sso login --profile
<name>` command right in the settings row; it is drawn from a BOUNDED shape
map and never interpolates the raw SDK message (finding 7).

The chain probe is BOUNDED by the probe's own `requestTimeoutMs` (finding 3):
resolution is not inherently bounded — `credential_process` can spawn a
hanging child, an SSO refresh can stall on a black-holed proxy, and IMDS has
its own long connect timeout — and an unsettled probe would wedge the
single-flight entry so every later click awaited the same dead promise. A
timeout settles as `unreachable` and releases the entry. This
is the ONE probe whose `detail` is not derived from an HTTP status — there is
no HTTP response, and the text is the agent's own, never a remote body.
Pinned by
`apps/desktop/src/__tests__/assistant-server/provider-verification.test.ts`,
the verify-provider block in `status-endpoints.integration.test.ts`,
`packages/assistant-contract/src/__tests__/provider-verification.test.ts`,
and the app-shell client/hook tests.

### Amazon Bedrock (BST-1350 bearer + catalog, BST-1353 AWS credential chain)

Registry entry `bedrock` (`authType: 'aws'`, `runtime: 'hosted'`, LLM-only).
TWO auth forms, both live, both under the one `aws` authType: a Bedrock API
key (bearer token, BST-1350) and the AWS default credential chain (SigV4,
BST-1353 — profiles, SSO, `credential_process`, web-identity/EKS, and
instance/container roles). The stored credential's `mode`
(`bearer` | `profile_chain`) discriminates them; exactly one reaches the
factory per request (see the auth-input EXACTLY-ONE rule above).

- **Auth precedence — FOUR rungs, two orthogonal axes.** Bearer-vs-chain is
  the PRIMARY axis; env-vs-stored applies WITHIN each mode. The whole table is
  decided in ONE place, `readProviderCredential`
  (`apps/desktop/src/provider-api-key.ts`):

  | # | Credential | Source |
  | --- | --- | --- |
  | 1 | env bearer — `BRAINSTRIKE_BEDROCK_API_KEY` > `AWS_BEARER_TOKEN_BEDROCK` (AWS's documented bearer variable) | env |
  | 2 | stored bearer — `{ type:'aws', mode:'bearer', bearerKey, region }` in the keychain | stored |
  | 3 | env chain — the ENV-CHAIN ACTIVATION RULE below | env |
  | 4 | stored chain — `{ type:'aws', mode:'profile_chain', region, profile? }` in the keychain | stored |

  **Rung 2 deliberately outranks rung 3 (do not relitigate).** A bearer key is
  an EXPLICIT, Bedrock-specific credential the user typed into Settings; an
  AWS environment is AMBIENT and is very often set for unrelated tooling on
  the same machine. Letting a stray `AWS_PROFILE` silently displace the key
  the user configured for this app would sign with an identity they never
  chose for it. `resolveHostedProviderCredential` already decides 1-vs-2, so
  the only work left in `readProviderCredential` is inserting 3 ahead of a
  stored chain. An env bearer key pairs with the region from `AWS_REGION`;
  every stored credential carries its OWN region.
- **ENV-CHAIN ACTIVATION RULE (BST-1353), stated once in
  `resolveAwsEnvChainCredential`:** `AWS_REGION` is set AND no bearer
  credential was resolved AND (`AWS_PROFILE` or `AWS_ACCESS_KEY_ID` is
  present). Each clause earns its place: a chain credential still needs a
  region and there is no default (the settled BST-1350 rule), env auth has
  nowhere else to carry one; "no bearer" is what makes rungs 1-2 beat rung 3;
  and the activation variable is the ONE gate on the chain — a machine with
  `~/.aws/config` but no AWS environment at all has NOT asked Brainstrike to
  sign with ambient credentials. Once activation passes the FULL chain runs
  (SSO, process creds, instance roles): the gate selects the MODE, it never
  narrows what the chain may consult — the same "installed unconditionally,
  like the AWS CLI" philosophy `aws-credential-chain.ts` documents, because
  gating on `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` would break every
  credential source the chain exists to serve. The region is deliberately NOT
  format-checked at activation: a malformed `AWS_REGION` must reach the
  factory's `INVALID_AWS_REGION_DETAIL` rejection rather than silently read as
  "Bedrock is not configured" — the same reasoning as the projection's
  deliberate `region: ''`.
- **The Credential Inventory's aws editor** (BST-1362
  `credential-row-editor.tsx`, two-mode since BST-1353) requires the region in
  BOTH modes, gates Save on the shared `isValidAwsRegion` with an inline
  invalid-region hint, and writes through the typed `saveCredential` bridge —
  never a bare `saveKey` string, which would drop the region silently; a
  store-side `malformed_credential` rejection toasts with the same
  region-format guidance. Full editor contract in the Credential Inventory
  bullet above.
- **Region rule (do not relitigate): a missing region is a typed init
  failure, never a default.** The ONE enforcement point is the factory
  validator (`assertValidProviderAuthInput` / `requireAwsAuthInput`, message
  `MISSING_AWS_REGION_DETAIL`: "Configure an AWS region for Bedrock in
  Settings…"). The projection deliberately emits `region: ''` when
  `AWS_REGION` is unset — its only visible-error channel is
  SecretReadError-shaped, and a missing region is a CONFIG failure, so it
  rides to the factory's actionable typed error instead of a misclassified
  secret failure.
- **Region FORMAT is SECURITY-enforced (PR #2522 review, finding 1).** The
  region is interpolated into the request hostname
  (`bedrock-runtime.<region>.amazonaws.com`), so a hostile "region" such as
  `evil.example.com/` exfiltrates the bearer token and prompt content. The
  shared `AWS_REGION_PATTERN` / `isValidAwsRegion`
  (assistant-contract provider-credential.ts) is enforced in BOTH layers:
  `isAwsCredential` (stored credentials, both modes — a bad region is
  `malformed_credential`, never coerced) and `assertValidProviderAuthInput`
  (`INVALID_AWS_REGION_DETAIL`, static text that never echoes the value).
- **A credential is REQUIRED — exactly one (finding 4, widened by
  BST-1353).** A region-only aws input throws
  `MISSING_AWS_CREDENTIALS_DETAIL`; bearer + chain together throws
  `CONFLICTING_AWS_CREDENTIALS_DETAIL`. Both live in
  `provider-auth-input.ts` and REPLACE BST-1350's
  `MISSING_AWS_BEARER_KEY_DETAIL`. The rule exists because with neither form
  the AI SDK falls back to ambient AWS environment credentials: chain auth is
  opt-in and EXPLICIT, arriving as a constructed `credentialProvider`, never
  as an ambient default.
- **Persona pins STILL cannot target Bedrock cross-provider (finding 5) —
  BST-1353 does not change this.** `personaProviderApiKeys` carries bearer
  STRINGS with no region seat (and a chain has no string form at all), so
  `createPersonaPinnedModelResolver` throws the pin-unresolvable path for any
  aws-authType pin (skip-with-warn upstream); its message still names
  BST-1353/BST-1358, and BST-1358 owns the region-carrying pin design.
  SAME-provider pins work: they reuse the parent's full aws auth input.
- **Prompt caching is REGISTRY-driven (BST-1354, closing finding 7).** Wrapper
  selection reads `LlmModelDefinition.promptCaching` (`'anthropic' | 'bedrock'`)
  through the single seam
  `packages/agent/src/providers/prompt-caching.ts`; the factory no longer
  chooses by provider id, and NEITHER the factory nor the wrappers may match on
  a model-id substring (pinned by `prompt-caching-selection.spec.ts`). Bedrock's
  catalog is exactly why: Claude and Nova v1 accept Converse `cachePoint`
  checkpoints, Llama/DeepSeek/Nova 2 Lite do not, and an undeclared route is
  sent NO breakpoints rather than a guessed dialect. Every first-party
  Anthropic row declares `'anthropic'`, so that path is unchanged.
  `wrapBedrockModelWithPromptCaching` places MESSAGE-level
  `providerOptions.bedrock.cachePoint = {type:'default'}` on the first 2 system
  plus last 2 non-system messages (OpenCode's policy) — exactly saturating
  AWS's four-checkpoint ceiling, honoring any pre-existing explicit cachePoint
  under either the `bedrock` or `amazonBedrock` spelling, and carrying the same
  two documented Proxy limits as the Anthropic wrapper. Message level (not
  content-part level) because the SDK reads `message.providerOptions` uniformly
  for system, user and assistant.
- **Cache PRICING is no longer Anthropic-first-party-only.** The old
  provider-registry-pricing pin ("non-Anthropic providers declare no cache
  rates") is gone; the invariant is now that a cache RATE and a
  `promptCaching` dialect travel together. Anthropic-on-Bedrock bills the
  Anthropic multipliers (read 0.1x, write 1.25x of input); Amazon Nova bills
  read at 0.25x and writes at the ORDINARY input rate, so its
  `cacheWritePerMTok` is deliberately absent — absence means "no premium",
  never "unknown".
- **Reasoning is per-model, by DIALECT (BST-1354).**
  `LlmModelDefinition.bedrockReasoning` is `'adaptive' | 'budget-tokens' |
  'max-reasoning-effort'`, and the dialects do not follow vendor lines:
  newer Claude routes REJECT `thinking.type:'enabled'` and need adaptive
  (`thinking:{type:'adaptive',display}` plus the effort in its own
  `output_config.effort`), Claude Haiku 4.5 keeps the legacy
  `{type:'enabled',budgetTokens}` form, and Amazon Nova takes
  `{type:'enabled',maxReasoningEffort}` with no token budget at all. The
  declaration is pinned — and each dialect's wire shape asserted — by
  `packages/agent/src/__tests__/bedrock-reasoning-dialect-contract.spec.ts`
  against `getModelCapabilities()` from **`@ai-sdk/anthropic/internal`**. Note
  the package: that table is the real source of truth and
  `@ai-sdk/amazon-bedrock` merely imports it, so an **`@ai-sdk/anthropic`**
  bump can move a Bedrock route between dialects with the Bedrock package
  untouched — re-check the pin on either upgrade. The pin asserts
  `isKnownModel` too, because the table DEFAULTS an unrecognized id to
  `supportsAdaptiveThinking: true`; without that assertion a typo'd or retired
  registry id would satisfy the adaptive branch having verified nothing. Every
  Claude-family row is REQUIRED to declare a dialect (absence fails rather than
  skips), and no non-Anthropic route may claim a Claude-only dialect.
  Nova v1 (pro/lite/micro) documents caching but NOT reasoning, so those rows
  declare `promptCaching` with no `bedrockReasoning` — the two capabilities are
  independent.
- **Bedrock reasoning DEPTH has its own settings key, `bedrockEffort`.** Not a
  reuse of `anthropicEffort`: Bedrock exposes no free-form thinking BUDGET, so
  the Anthropic pair would leave the Thinking toggle writing
  `anthropicThinkingBudgetTokens` that the Bedrock request builder drops — a
  switch reading on while nothing is requested. For the same reason
  `ReasoningControlsAvailability` gained its own `family: 'bedrock'` (effort
  submenu, no thinking toggle) rather than borrowing the Anthropic family.
  `BEDROCK_REASONING_EFFORTS` is the per-dialect OFFERED list, deliberately
  narrower than the type — same offered-vs-membership discipline as
  the per-model `anthropicReasoning` ladders. An effort the selected route does
  not offer yields NO provider options rather than a request the API would reject.
- **Visibility (BST-840) projects onto Bedrock through
  `resolveBedrockReasoningDisplay`** (`reasoning-visibility.ts`), which maps the
  shared switch to `reasoningConfig.display` (`summarized`/`omitted`, same
  vocabulary and same provider-side `omitted` default as first-party
  Anthropic). The SDK honors `display` ONLY for the `adaptive` dialect, so it is
  attached there alone — mirroring the existing first-party rule that the legacy
  budget form carries no `display`. That is an ABSENT knob on the other two
  dialects, not an ignored setting.
- **`providerOptions.bedrock` is generation-only — no stream-boundary
  stripping.** Unlike `providerOptions.ollama`/`.lmstudio` (transport config:
  `baseUrl`/`apiToken`, which would serialize into the request body), the
  bedrock namespace carries only `reasoningConfig`, which is precisely what
  Mastra must forward to the SDK. So it is deliberately NOT added to
  `buildGenerationProviderOptionsOption`'s strip list in
  `runtime-assembly/stream-options.ts` (moved out of `agent-streaming.ts` by
  BST-1649).
  If a future Bedrock ticket adds transport-ish fields (endpoint override,
  credentials), replicate the ollama/lmstudio stripping at that point.
- **Replayed history is normalized for Converse
  (`bedrock-message-hygiene.ts`).** A Bedrock-scoped input processor, installed
  beside the OpenAI compat seams and running after them, drops empty text parts
  and empty reasoning parts, keeps reasoning that carries
  `providerOptions.bedrock.signature`/`.redactedData` (the provider's proof that
  thinking happened), drops messages left with no content, and rewrites
  tool-call ids outside `[a-zA-Z0-9_-]` to `_`. The id charset is an API-level
  Converse `toolUseId` constraint rather than a model-family quirk, so it
  applies to every Bedrock route and is a no-op on already-valid ids; calls and
  their results rewrite deterministically so pairs stay matched. Like every
  compat processor it is a TRANSIENT provider-boundary rewrite and never
  touches durable history.
- **DB catalog enablement (finding 8).** Migration 100 seeds the provider row
  and every model row `is_enabled = false` — the same shape as the
  openrouter seed. Enablement comes from `useBedrockDefaults`
  (packages/app-shell), which mirrors `useOpenRouterDefaults`: on the first
  readable bedrock configuration it enables `BEDROCK_RECOMMENDED_MODEL_IDS`
  (assistant-contract) through the idempotent, user-choice-preserving
  `initializeProviderModelDefaults`. Keep the two hooks parallel; the panel
  wrapper consumes them through the ONE composed seam
  `useProviderModelDefaults` (wrapper composition budget).
- **Credential projection** (`providerAuthInputFromCredential`): on an
  aws-auth provider an `api_key` credential (env bearer) and an aws/bearer
  credential both project to `{ kind: 'aws', region, apiKey }`; an aws
  credential stored for a NON-aws provider throws the SecretReadError-shaped
  `credential_type_unsupported`. Since BST-1353 aws/profile_chain projects to
  `{ kind: 'aws', region, credentialProvider }` — but ONLY when the caller
  INJECTED an `awsCredentialChain` capability
  (`ProviderAuthProjectionOptions`). **That injection IS the structural proof
  that Hosted Web never resolves a chain (do not relitigate):** desktop main
  passes `createAwsCredentialChain` (in BOTH places — the
  `prepareAssistantPostRequest` call and `deriveAssistantTurnAuthInput`, so a
  credential that passed preparation cannot fail to project at turn time);
  web passes nothing, so the SAME credential throws
  `credential_type_unsupported` there. It is a capability, not an import,
  which additionally keeps the Node-only `@aws-sdk/credential-providers` out
  of the shared assistant-service package entirely — the type is erased at
  compile time. The unsupported-detail text now names the requirement
  ("requires the desktop app — it reads your local AWS profiles") instead of
  pointing at BST-1353. The string SHIM deliberately calls the projection with
  NO options, so a profile_chain credential still throws on every bearer-only
  consumer (persona pins, persistent memory, the OpenRouter metadata
  endpoint): a chain has no bearer string to hand them, and returning
  `undefined` would read as "not configured".
- **The chain module** (`packages/agent/src/providers/aws-credential-chain.ts`,
  NODE-ONLY): `createAwsCredentialChain(profile)` builds the chain object
  eagerly (no IO) and keeps RESOLUTION lazy inside the returned closure, so
  each request pays a fresh resolution and picks up an `aws sso login`
  performed mid-session without an app restart. Resolution being lazy is also
  why a bad profile fails MID-RUN rather than at model construction —
  `@ai-sdk/amazon-bedrock` calls the provider when it signs. Raw SDK text is
  useless to a user, so every rejection is translated at the seam that still
  knows which profile was searched:
  `classifyAwsChainFailure` → `{ kind: 'no_credentials' | 'sso_expired' |
  'unknown', detail }`, wrapped as a typed `mastra_agent_runtime_init_failed`
  on the request path and returned as DATA by `verifyAwsCredentialChain` on
  the probe path. `unknown` is a first-class outcome, never quietly folded
  into the other two (NO SILENT FALLBACKS: a DNS failure during an SSO refresh
  must not read as "run aws sso login").
- **Two MEASURED findings drive that classifier — do not "simplify" them
  back.** An empirical probe against `@aws-sdk/credential-providers` 3.1111.0
  (bogus HOME + profile dirs; reproduced as the EMPIRICAL block of
  `aws-credential-chain.spec.ts`, which runs the REAL SDK hermetically with
  IMDS disabled) established: (1) there is NO distinct expired-SSO error
  class — every failure, from "no credentials anywhere" to four different SSO
  variants, is the single class `CredentialsProviderError` — so the
  discriminator has to be the MESSAGE, and the stable marker across all four
  SSO variants is the substring `sso login`, UNQUOTED because the
  legacy-profile variant writes `run aws sso login` without the surrounding
  quotes that the other three carry; (2) that class is NOT importable here —
  it is defined in `@smithy/property-provider`, a transitive package that
  does not resolve from `packages/agent` (verified: `ERR_MODULE_NOT_FOUND`) —
  so `instanceof` is unavailable and the check is STRUCTURAL, on
  `error.name`, the same technique `matchSecretReadError` uses across the IPC
  boundary. The measured failure table lives in the module header; refresh it
  there if the SDK is bumped.
- **Which mode is WINNING is VISIBLE (BST-1353).** `ProviderKeySource`
  (`packages/assistant-contract/src/provider-key-source.ts`) gained an
  optional `authMode: 'bearer' | 'profile_chain'`, present only on
  aws-authType providers; `inspectProviderKeys` reports the WINNER (its
  env-chain pass runs LAST, mirroring rung 3, so the listing's verdict cannot
  disagree with what `readProviderCredential` resolves on the next request),
  and `KeySourceBadge` appends "· AWS profile chain". Without it a user with
  both a stored bearer key and an `AWS_PROFILE` environment has no way to
  tell which one the next request signs with. `AWS_CHAIN_ACTIVATION_ENV_NAMES`
  + `isAllowedProviderKeySourceEnvVar` live in the same module as the ONE
  definition: the chain activation names are NOT registry credential names, so
  BOTH strict key-source parsers (the contract's `parseProviderKeySources` via
  the settings Credential Inventory, and the app-shell availability probe)
  must accept them on aws providers or a working chain would render as
  "Invalid provider key source". Both parsers were relaxed from exact-key-COUNT
  checks to allowed-key-SET checks to admit the optional `authMode` — an
  UNRECOGNIZED key still rejects the whole payload, and a present-but-unknown
  `authMode` is malformed, never coerced or dropped.
- **Packaging.** `@aws-sdk/credential-providers` is catalog-pinned at
  3.1111.0 and added to tsup's `sharedExternal`, so esbuild can never inline
  it into a browser entry. The chain is exported from the agent ROOT
  entrypoint ONLY — never `browser-safe`, `client`, or `provider-metadata` —
  so a renderer import cannot reach it. `provider-auth-input.ts` stays
  edge-free via the import-free identity module (see the auth-input section).
- **Model ids are stored UNPREFIXED** (registry + DB catalog, migration
  100). The cross-region inference-profile prefix (`us.`/`eu.`/`jp.`/`au.`
  geo, or `global.`; `apac.` passes through if already present) is applied per
  request by `packages/agent/src/providers/bedrock-model-id.ts`. Since the
  PR #2522 review (finding 2/3) the geo tables are EXACT profile-id sets
  derived from models.dev ground truth (dated in the module header) — a geo
  prefix is emitted only when that regional profile is listed; otherwise the id
  is sent verbatim and Bedrock reports the outcome. Never double-prefixes;
  `us-gov*` excluded from `us.`; no `apac.` profiles exist today. Refresh
  procedure lives in the module header.
- **An AWS model card OUTRANKS models.dev (BST-1694, PR #3080 review;
  `jp.` set audited to completion in BST-1710).** models.dev is a third-party
  mirror: it can list a regional profile AWS never published, and it can
  equally MISS one AWS does publish. Emitting a profile AWS does not publish is
  a client-MANUFACTURED failure, strictly worse than the verbatim id Bedrock
  can answer for. Where a card enumerates a model's profiles the card wins, and
  the divergence is recorded inline in the module header.
  - **Phantoms removed:** `anthropic.claude-opus-5` (BST-1694) and
    `anthropic.claude-sonnet-5` (BST-1710) are NOT in the `jp.` set. Each
    card publishes `us.`/`eu.`/`au.`/`global.` only, carries no "Geo: JP"
    section, and marks ap-northeast-1 In-Region ✗ / Geo ✗ / Global ✓.
  - **The audit cuts both ways:** BST-1710 also found
    `anthropic.claude-opus-4-7` MISSING from the `au.` set although its card
    publishes `au.anthropic.claude-opus-4-7` and marks ap-southeast-2/-4
    Geo ✓ — so ap-southeast-2/-4 were emitting an id Bedrock cannot invoke.
    It was ADDED. Under-emission and over-emission are the same defect.
  - **Card-verified as published, kept in `jp.`:** `anthropic.claude-opus-4-7`,
    `anthropic.claude-opus-4-8`, `anthropic.claude-sonnet-4-5-20250929-v1:0`,
    `anthropic.claude-sonnet-4-6`,
    `anthropic.claude-haiku-4-5-20251001-v1:0` (retrieved 2026-09-10). Ids
    whose cards were not read keep their models.dev membership; none of them
    is in the `jp.` set, so none can be a `jp.` phantom.
  - **Closed by BST-1711 (next bullet):** removing a phantom used to leave
    Tokyo on the verbatim id, because the module emitted no `global.` ROUTING
    at all. It does now, so the two rows the audit had to leave verbatim
    resolve to `global.anthropic.claude-opus-5` and
    `global.anthropic.claude-sonnet-5` in ap-northeast-1 — exactly what those
    cards publish for it.
- **`global.` ROUTING, and its precedence (BST-1711).** The current Claude
  cards mark the BASE model id In-Region ✗ in EVERY region, so the bare
  `anthropic.claude-opus-5` is not invocable at `bedrock-runtime` anywhere — a
  geo or global profile is mandatory, and AWS's own card sample code calls
  `global.<id>`. The module now emits `global.` from a per-MODEL table of the
  regions each card marks **Geo ✗ / Global ✓**, transcribed from the cards'
  Regional Availability tables (never models.dev).
  - **Precedence is geo → global → verbatim.** Data residency is the stronger
    guarantee, so a region that has a geo profile for that model keeps it.
    Because global is only ever consulted after geo misses, and only for
    regions the card marks Geo ✗, this can only REPLACE an uninvocable
    verbatim id — it can never downgrade a working geo route.
  - **GovCloud never receives `global.`** — `us-gov-west-1`/`us-gov-east-1`
    are Global ✗ on every card that lists them (Opus 5, Fable 5.1, Sonnet
    4.5), so they are in no global set. Pinned by a spec case.
  - **A model absent from the table never gets `global.`, and that absence is
    a DECISION, not a default.** Every id this module names — each Bedrock
    catalog id plus every member of the four geo sets — must appear either as
    a key of `GLOBAL_PROFILE_REGIONS_BY_MODEL` or in
    `NO_GLOBAL_PROFILE_MODEL_IDS`, whose comment carries the per-id reason
    ("N/A" / "Not supported" on the card, or no cross-region profile of any
    kind). `bedrock-model-id.spec.ts` asserts that partition in both
    directions against the real catalog, so a newly added id fails the suite
    until someone classifies it. That is the refresh contract: an unclassified
    Claude id would otherwise be silently uninvocable outside its geo regions.
  - The table is per model because the cards genuinely disagree: Opus 4.5 has
    no AU geo (Sydney is global-only for it alone), Fable 5/5.1 have no EU geo
    (all eight EU regions are global-only), and `ca-west-1` is Geo ✗ on the
    Haiku 4.5 / Sonnet 4.5 cards but Geo ✓ on others.
  - **Shadowed entries are enumerated, not implied.** Because geo is checked
    first, a global entry for a region the model ALSO has a geo profile in is
    dead code. Exactly one such family exists today — `fable-5` in the seven
    mapped EU regions, where the `eu.` set is itself a suspected phantom (see
    Still open). It is kept, not deleted, because the fix is to drop the
    phantom rather than the global row; a spec case iterates the whole table
    and fails if any UNLISTED shadowed pair appears.
  - **Still open (follow-up):** the GEO map is still prefix-shaped, so regions
    the cards mark Geo ✓ that it does not map keep sending the verbatim id —
    `ca-central-1`/`ca-west-1`, `eu-central-2`, `ap-northeast-3`,
    `ap-southeast-6`. Those are UNDER-emissions. Also
    `anthropic.claude-fable-5` sits in the `eu.` set although its card
    publishes `us.`/`global.` only — a BST-1710-class phantom found while
    building the global table, filed rather than folded in. Its visible
    symptom is a split INSIDE the EU: `eu.anthropic.claude-fable-5` in
    `eu-west-1` (mapped, geo wins) but `global.anthropic.claude-fable-5` in
    `eu-central-2` (unmapped, global wins). Both are pinned, so closing the
    phantom has to change them deliberately.
- **Exclusions:** no embeddings (`createEmbeddingProvider` throws), not a
  persistent-memory provider (`PERSISTENT_MEMORY_LANGUAGE_MODEL_PROVIDERS`),
  and NOT in `HOSTED_WEB_ASSISTANT_PROVIDERS` (desktop-only until a web ticket
  says otherwise). `@ai-sdk/amazon-bedrock` is Node-only: it is imported
  solely from provider-factory-adjacent modules, never from the browser-safe
  agent subpaths. Web's exclusion is enforced STRUCTURALLY as well as by that
  list: no `awsCredentialChain` capability is injected there, so a
  profile-chain credential cannot resolve on web even if the provider list
  changed.
- **Env name classification — THREE sets, and the scrub is a DENY-LIST
  (PR #2525 review, finding 1 — SECURITY).**
  `createCredentialIsolatedChildEnvironment` copies every name NOT in the
  scrub set, so "absent from every set" means "passed through VERBATIM to
  repository-controlled children" (execute-command-tool, the hook executor),
  not "protected". Because BST-1353 documents shell-set AWS static keys as a
  supported way to ACTIVATE the chain, they are routinely present in a real
  desktop process env — leaving them unlisted was a live credential-leak path.
  The two roles are therefore separate constants in
  `apps/desktop/src/desktop-env.ts`:
  - `CREDENTIAL_ENV_FILE_VARIABLE_NAMES` — registry + Tavily names a `.env`
    FILE may set.
  - `SCRUBBED_CREDENTIAL_ENV_VARIABLE_NAMES` — the scrub deny-list: the file
    set PLUS ambient-only credentials `AWS_ACCESS_KEY_ID`,
    `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`. INVARIANT: a strict superset
    of the file set (pinned).
  - `NON_CREDENTIAL_SUPPORTED_ENV_FILE_VARIABLE_NAMES` — `AWS_REGION` and
    `AWS_PROFILE`: configuration, file-loadable, deliberately NOT scrubbed (a
    child may need the region; `AWS_PROFILE` only NAMES a profile). BST-1363
    renders this set as muted "config" chips, which is the second reason a
    secret must never land here.

  AWS static keys are scrubbed but remain NOT file-loadable — adding them to
  the scrub must not hand a `<userData>/.env` write a new credential channel.
  Tests assert the scrub OUTCOME (child env lacks all three), not set
  membership, plus a tripwire rejecting any `KEY|SECRET|TOKEN|PASSWORD` name
  in the non-credential set. The code-execution fence's `INHERITED_ENV_VARS`
  carries no `AWS_*` name and must not gain one.

Pinned by `packages/agent/src/__tests__/aws-credential-chain.spec.ts` (the
classifier branches plus the EMPIRICAL real-SDK block that MEASURES the
failure table),
`packages/agent/src/__tests__/provider-factory.bedrock.spec.ts` (its BST-1353
cases cover the profile-chain stream signing SigV4 on a mocked wire, a chain
rejection surfacing through the stream rather than signing unauthenticated,
and both EXACTLY-ONE violations) + `bedrock-model-id.spec.ts`, the aws-pin
cases in `packages/agent/src/mastra/__tests__/persona-pinned-model.spec.ts`,
the region-format cases in
`packages/assistant-contract/src/__tests__/provider-credential.test.ts` +
`bedrock-defaults.test.ts`,
`packages/assistant-service/src/__tests__/provider-credential-projection.test.ts`
(the injected-vs-absent chain capability pair IS the desktop/web proof)
+ the BST-1350/BST-1353 blocks in `request.test.ts`,
`packages/app-shell/src/hooks/use-bedrock-model-defaults.test.tsx`, the aws
editor cases (save semantics + region-format gate) in
`packages/settings-ui/.../__tests__/credential-inventory.test.tsx`, and
the BST-1350 pins in `apps/desktop/src/__tests__/main/desktop-env.test.ts`.

### OpenAI Codex — ChatGPT subscription provider (BST-1356)

The FIRST `oauth_subscription` provider, and the first consumer of the
BST-1355 engine. Legal gate: `docs/OAUTH_LEGAL_REVIEW_GATE.md` (signed,
8 binding constraints; the implementation record lives there too).

**Descriptor** — `apps/desktop/src/provider-auth/descriptors/openai-codex.ts`.
Supplies endpoints/shapes ONLY; the engine owns PKCE, the loopback server, the
poll loop, the token exchange and refresh. The device flow is NOT RFC 8628
(JSON bodies, `/api/accounts/deviceauth/{usercode,token}`, 403/404 = keep
polling, and a poll success returning an authorization code plus a
SERVER-supplied `code_verifier`), which is expressed through the engine's
`DeviceFlowResponseAdapter` seam with zero engine changes.

**Model ids are `codex/`-prefixed.** The `models` table's `id` is a GLOBAL
primary key (migration 015), so a bare `gpt-5.5` catalog row would collide
with — and on upsert HIJACK — the platform `openai` row of the same id. Every
multi-route provider namespaces for this reason (`openrouter` uses `openai/…`,
`bedrock` uses `anthropic.…`). `resolveCodexModelId`
(`packages/agent/src/providers/codex-model-id.ts`) strips the prefix to the
bare wire id, mirroring `resolveBedrockModelId`; an UNPREFIXED id THROWS
rather than passing through.

**Pricing is omitted on every model.** Usage draws on the subscription, not
metered billing, so the UI renders "cost unavailable". A zero price would
assert a cost we do not know.

**Runtime path.** The factory case builds the ordinary OpenAI Responses client
but requires `custom_fetch` auth (`requireCustomFetchAuthInput` — an
`api_key` input would quietly bill the user's METERED account). All
authentication lives in the fetch closure
(`apps/desktop/src/provider-auth/codex-fetch.ts`): strip the SDK's
authorization header (all three `HeadersInit` shapes), attach the fresh
subscription bearer, `ChatGPT-Account-Id`, `originator: brainstrike`,
`session-id` and the honest UA, rewrite onto
`https://chatgpt.com/backend-api/codex/responses`, and pin `store: false`.
`maxOutputTokens` is never set, matching the Codex CLI.

**Interactive-desktop-only (gate constraint 4)** is enforced at the
credential-resolution layer, NOT in UI copy — see `apps/desktop/SECURITY.md`
for the two-gate description. The short version: the shared projection's oauth
arm requires an injected `oauthSubscriptionFetch` capability that only the
interactive desktop assistant-server supplies, and that supplier re-checks per
resolution that a `visible-ui` window exists.

**Assistant-token origin tracking**
(`apps/desktop/src/provider-auth/assistant-auth-origin.ts`, BST-1356):
`assistant:get-auth` records the issuing WebContents id on every token
issuance (idempotent `Set.add`), and `resolveAssistantAuthOriginRole`
re-reads the role registry per credential resolution — the record never
caches authority, so a torn-down or role-cleared sender stops authorizing
immediately. Cleanup lifetime invariant: exactly ONE `'destroyed'` listener
per WebContents removes the id, de-duped via a `WeakSet<WebContents>` in
`apps/desktop/src/main-platform-ipc.ts`. Do not attach per issuance —
renderer reloads preserve the WebContents and re-request auth, so
per-issuance listeners stack until `MaxListenersExceededWarning`. Reloads
need no listener of their own: re-issuance re-records the same stable id.
The listener is bookkeeping only, never the security boundary (the per-
resolution role re-read above is). Pinned by the destroyed-listener tests in
`apps/desktop/src/__tests__/main/main-platform-ipc.test.ts`.

**ONE engine instance** is shared by the IPC domain and the assistant server
via `provider-auth-runtime.ts`. This is load-bearing: a second engine would
carry its own single-flight map and REPLAY a rotating refresh token.

**When changing any of this**, update this section, `apps/desktop/SECURITY.md`,
and the paired tests under `apps/desktop/src/__tests__/provider-auth/`.

#### Contract for any provider-listing UI (read before rendering a credential card)

`oauth_subscription` providers are **connect/disconnect**, never paste-a-key.
Do NOT treat "everything except `authType === 'none'`" as key-bearing — that
predicate is wrong for this auth type and will render a ChatGPT account as an
API-key text field.

A surface that lists providers MUST branch on `authType`:

| `authType` | Treatment |
| --- | --- |
| `'none'` | No credential affordance (local runtimes). |
| `'api_key'` | Key input / Set / Replace / Remove. |
| `'aws'` | Key input OR profile-chain selection (BST-1353). |
| `'oauth_subscription'` | **Connect / Disconnect only.** No key input, no Set/Replace/Remove. Must render the connected account, a device-code alternative, and the personal-use notice (legal gate constraint 4). |

The reference implementation is the Credential Inventory's oauth arm
(`packages/settings-ui/src/settings/secrets/credential-inventory/credential-oauth-actions.tsx`
plus `credential-oauth-notice.tsx`); reuse it rather than re-deriving the
states. Connect affordances are capability-gated on the `window.providerAuth`
bridge — absent on web, where the row must render read-only rather than
offering a sign-in that cannot work.

### Provider OAuth engine (BST-1355)

Desktop-main-only, provider-agnostic OAuth engine at
`apps/desktop/src/provider-auth/` (pkce / loopback-server / device-flow /
oauth-flow / refresh / descriptor-registry / provider-auth-engine). Bound by
the SIGNED legal gate `docs/OAUTH_LEGAL_REVIEW_GATE.md` — its 8 constraints
are acceptance criteria, not guidance. Do not relitigate there-settled
rulings (e.g. Anthropic subscription OAuth is PERMANENTLY REJECTED).

**Descriptor contract** (`OAuthProviderDescriptor` in
`packages/assistant-contract/src/provider-auth.ts`): providerId, clientId,
authorizeUrl, tokenUrl, `redirectPort` + `redirectPath` (loopback client
registrations pin the EXACT redirect URI — a busy port is a typed visible
`port_in_use` error naming the port, NEVER a random-port fallback; only test
fixtures may use port 0), scopes, optional `extraAuthorizeParams`, optional
`deviceFlow` (`startUrl`/`pollUrl`/`verificationUri` + optional
`responseAdapter` — the engine owns loop mechanics (interval + safety
margin, RFC 8628 slow_down backoff, deadline, cancellation) while the
adapter owns request/response SHAPE only, which is what makes opencode's
non-standard Codex flow (JSON bodies, 403/404 = keep polling, poll success
returns an authorization code + server-supplied code_verifier needing a
standard exchange) expressible with zero engine changes), and optional
`extractAccountId`. The descriptor REGISTRY
(`descriptor-registry.ts`) ships EMPTY in BST-1355; **BST-1356 ships the
first active descriptor (OpenAI Codex)**. Unknown provider = typed
`unknown_provider`, never a default.

**Status model** (`ProviderAuthStatus`, same file): `disconnected |
connecting | awaiting_browser | awaiting_device_code {userCode,
verificationUri} | connected {accountId?} | error {code} |
reconnect_required`. This union is the ONLY renderer-visible surface —
token material NEVER crosses IPC (gate constraint 3; pinned by the
no-token-over-IPC tests in
`apps/desktop/src/__tests__/provider-auth/provider-auth-ipc.test.ts` and the
fake-provider integration test). The `provider-auth` IPC domain
(start/cancel/status/disconnect) registers every channel
`{ roles: ['visible-ui'] }` via `registerAuthorizedInvoke`
(interactive-desktop-only, gate constraint 4); the preload exposes
`window.providerAuth` (`ProviderAuthBridge`), the hidden preload EXCLUDES it
(contract test), and the credential-resolution layer must call
`assertInteractiveProviderAuthSender` before resolving an OAuth credential.

**Refresh** (`refresh.ts`): single-flight per provider (concurrent callers
collapse onto one network call — rotating refresh tokens are never
replayed), proactive refresh inside a 120s expiry skew, persisted rotation
(server-omitted refresh_token keeps the old one per RFC 6749 §6), and every
engine fetch (exchange, device start/poll, refresh) runs under the flow's
AbortSignal + a 30s per-request timeout (`fetch-guards.ts`).
`invalid_grant`/revoked = typed `reconnect_required` result + status; the
stored credential is KEPT (never deleted silently; the user disconnects or
reconnects explicitly), and nothing ever retry-loops.
Rotation-then-persist-failure holds the rotated pair IN MEMORY as the active
credential (session keeps working; status `credential_persist_failed`; a
later successful persist clears it; restart lands in `reconnect_required`).
Disconnect bumps a per-provider epoch so an in-flight refresh completing
afterwards discards its result and persists nothing. A successful exchange
that returns no refresh_token is the distinct `refresh_token_missing` code
(scope problem, not a transient failure). Engine-written credentials are
`{ type: 'oauth', access, refresh, expires, accountId? }` in the BST-1348
secrets store, so factory reset already wipes them (guarded in
`apps/desktop/src/__tests__/secrets.test.ts`).

Threat model + loopback hygiene live in `apps/desktop/SECURITY.md`
("Provider OAuth subscription auth" section). When changing the engine,
update BOTH docs and the paired tests under
`apps/desktop/src/__tests__/provider-auth/`.

### Env bootstrap visibility (BST-1363)

Why it exists: env-file bootstrap was invisible. One malformed line makes the
loader reject the WHOLE file (see the env-file rules above — validation is
all-or-nothing by design), so every credential in it silently stops applying
and the app behaves exactly as if the keys were never set. Settings now states
the outcome instead of leaving the user to guess.

**Payload rule — NAMES ONLY, NEVER VALUES (do not relitigate).** The
projection carries variable NAMES, file PATHS, counts, and the loader's own
failure messages. It never carries a variable's value, nor a prefix, hash, or
length of one. The producer
(`apps/desktop/src/desktop-env-report.ts`) builds the name lists by
intersecting the allow-listed NAME sets
(`CREDENTIAL_ENV_FILE_VARIABLE_NAMES` /
`NON_CREDENTIAL_SUPPORTED_ENV_FILE_VARIABLE_NAMES`) with mere PRESENCE in the
process environment — a value is read only to ask "is this non-blank?", so it
has no path into the payload by construction rather than by a post-hoc scrub.
`apps/desktop/src/__tests__/desktop-env-report.test.ts` seeds a distinctive
fake key value and asserts the serialized payload does not contain it. This
matches the `deprecatedEnvVars` precedent: names only, never values.

Shape and transport: `EnvBootstrapReport` is defined ONCE in
`packages/assistant-contract/src/env-bootstrap-bridge.ts` (with the
`ENV_BOOTSTRAP_BRIDGE_REQUIRED_METHODS` pin the preload-runtime contract test
enforces). Channel `secrets:envBootstrap` is registered in
`apps/desktop/src/ipc-secrets.ts` with the same `visible-ui` role policy as
every other secrets channel; `hidden-preload.ts` does not expose it
(negatively asserted in `hidden-preload-contract.test.ts`).

Rulings worth keeping:

- The handler reads the RECORDED bootstrap result and re-projects it per
  invoke. It NEVER re-runs loading — `initializeDesktopEnvironment` throws on
  double-init, and re-reading files would report a state the running process
  is not actually in. This is also why the UI states "Changes to environment
  files apply after restart."
- Unlike `secrets:list`, this channel deliberately does NOT throw on env-file
  failures. `secrets:list` throwing is correct (its answer would be wrong);
  this channel exists precisely to explain that failure, so it must still
  answer.
- The section reads ONCE on mount. It deliberately does NOT subscribe to
  `SECRETS_CHANGED_EVENT_NAME` or window focus: the payload derives from the
  recorded bootstrap plus the process environment, and neither can change
  without a restart, so a refresh could only ever re-fetch an identical
  payload while implying the panel is live. Do not add one back.
- Deprecation guidance has ONE source. The rename target is
  `DeprecatedEnvVarReport.replacement` — the VENDOR-standard name, never the
  `BRAINSTRIKE_*` override — and both the inventory row and the Environment
  section render it through the single
  `settings/secrets/deprecated-env-var-message.ts` helper. A second derivation
  previously advised the override while the row advised the vendor name, with
  both on screen simultaneously. Do not re-derive it.
- A name counts as retired based on the REGISTRY
  (`providerDeprecatedEnvKeys`), not on whether the loader saw it in a file.
  A retired name exported from the user's shell is just as dead as one spelled
  in `.env`, so neither may render as a live chip; file provenance only adds a
  clause to the warning.

File ids (`dev` / `dev-local` / `user-data`) are internal loader vocabulary and
must never reach the UI. `DESKTOP_ENV_FILE_LABELS` in the contract is the ONE
map to their real filenames, and the loader itself formats failure messages
through it — so the same wording reaches Settings, the status probe, and the
`secrets:list` error.

Surface: `packages/settings-ui/src/settings/secrets/environment/`, rendered
beneath the Credential Inventory. Read-only — no editor, because the values
are secrets this surface must never handle. The failure banner reproduces the
parser's line-precise message verbatim (`… is invalid at line 4: unsupported
variable name.`) — that text is the feature, so do not re-word it — and states
the all-or-nothing consequence, since one bad file discards them all.
Effective variables render as monospace chips, credential chips visually
distinct from non-credential config chips and cross-linked to their inventory
row; the chip→row index is built from `listCredentialSlots()` so a chip can
never target a row that does not exist. The "Open folder" affordance is
INJECTED by the desktop host from `resolvePlatformBridge()`, and its
`{ ok, error }` result is surfaced — settings-ui never touches
`window.platform`, and web omits the section entirely by capability (the
bridge is absent), never by an `isElectron()` check.

Tavily's env names are NOT in the provider registry (it is a search service,
not a model provider). The canonical list lives in
`@brainstrike/assistant-contract/tavily-env-keys` because both desktop and
settings-ui need it; every local copy that existed instead had drifted.

### Anthropic `thinking` mirrors: what is deliberately NOT mirrored

`AnthropicThinkingOptions` in `packages/agent/src/types.ts` and
`packages/assistant-contract/src/runtime-data.ts` hand-mirror the provider's
`thinking` discriminated union, guarded by
`scripts/__tests__/ai-sdk-anthropic-mirror-contract.test.mjs` (BST-1310). Two
standing rulings, recorded here because the next person to hit a type error will
read this file before that test:

- **`adaptive.display` includes `'updates'`** as of `@ai-sdk/anthropic` 4.0.49.
  The mirrors carry it because being strictly narrower than the provider is the
  bug class the guard exists to catch. Nothing emits it yet —
  `resolveReasoningVisible` still produces only `'omitted' | 'summarized'` — and
  the provider attaches a `thinking-display-updates-2026-08-18` beta header for
  it, so a picker generated from this union would offer a value that can fail
  against non-beta accounts. Derive pickers from an explicit const array, not
  from the mirrored type.
- **`{ type?: never; blockBinding }` is NOT mirrored.** 4.0.49 added a second,
  *undiscriminated* member alongside the discriminated union. It carries no
  `type` literal, so it is outside the guard's scope by construction, and
  adopting `blockBinding` is a feature decision about what the app emits rather
  than drift the guard is entitled to force. The mirrors are therefore knowingly
  narrower in that one dimension.

### Sampling params are never sent on a default request (BST-1699)

Three vendors now reject or deprecate non-default sampling params on their
newest models — OpenAI `gpt-6-astra` (no custom `temperature`/`top_p`), Google's
2026-07-21 changelog (`temperature`/`top_p`/`top_k` deprecated on the latest
Gemini models), Anthropic Opus 4.7+ (non-default values return HTTP 400, repeated
verbatim on AWS's Claude Fable 5.1 Bedrock model card). The audit ruling, which
new provider or runtime work must preserve:

- **A default request carries no `temperature` / `top_p` / `top_k` on any of the
  five adapters** (openai, anthropic, google, bedrock, openrouter). No
  `createProvider` case passes sampling settings at construction.
- **There is exactly one path by which a sampling param can reach a hosted
  provider**: `RuntimeData.modelSettings` → Mastra's per-call `modelSettings` →
  the AI SDK adapter. Both Brainstrike-owned producers on that path emit
  `maxOutputTokens` and nothing else: `buildModelSettings`
  (`packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts`) and
  `buildModelSettingsOption`
  (`packages/agent/src/mastra/runtime-assembly/stream-options.ts`), whose
  openrouter/local backstops only ADD a `maxOutputTokens` ceiling.
- **`RuntimeModelSettings`
  (`packages/assistant-contract/src/runtime-data.ts`) has no `topK` field**, so
  `top_k` is unreachable on every hosted route. Adding one would put us on the
  wrong side of all three vendor rules — do not add it without reading this
  section.
- The **Prompt Workbench** (`buildPromptModelSettings`,
  `packages/app-shell/src/prompt-workbench-shared.ts`) is the only surface that
  can produce a user-set `temperature`/`topP` at all.

**BST-1701 — a dropped value is now REPORTED (was: silently dropped).** On a
model that rejects sampling params the installed adapter does not 400 and does
not forward the value: it DROPS it and reports an `unsupported` entry on the
call's `warnings`. That array had no consumer, so the user's explicit setting
vanished with no notice. It is now surfaced; see "Provider call warnings" below.
The characterization test above is the "before" half and stays as-is — nothing
about what is SENT changed.

Guarded by `packages/agent/src/__tests__/sampling-params-wire.spec.ts`
(per-adapter assertion on the SERIALIZED REQUEST BODY through the real
`createProvider`, recursive scan in both casings because the adapters nest these
fields differently) and the BST-1699 block in
`packages/agent/src/mastra/runtime-assembly/__tests__/stream-options.spec.ts`.
The wire spec's fetch capture must decode BOTH valid call shapes —
`fetch(url, init)` and `fetch(new Request(url, init))` — since reading only
`init.body` records `null` under the Request shape and turns the suite green on
exactly the adapter drift it exists to catch.

### Provider call warnings are surfaced on the turn (BST-1701)

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

---

## MCP TRANSPORT SELECTION (CRITICAL)

Every MCP server chooses its transport explicitly. The authoritative config
discriminator is one of `stdio`, `streamable-http`, or legacy `sse`; it is never
omitted, inferred from a URL path, or changed after a failed connection.

Protocol policy is a separate discriminator: `legacy`, `auto`, or the pinned
`2026-07-28`. Existing entries that omit it normalize to `legacy` without
rewriting their JSONC; the loader emits a durable warning and a structured
`mcp_protocol_defaulted_to_legacy` migration record. Explicit policy is never
inferred from URL, transport failure, status code, or server behavior. Legacy
SSE accepts only `legacy`.

The production HTTP and stdio clients expose the official SDK's negotiated
facts through `getProtocolEra`, `getNegotiatedProtocolVersion`,
`getServerVersion`, and `getServerCapabilities`. Those getters return
`undefined` before connection and after close; modern server identity may also
be absent because it is optional discovery metadata. `auto` probes
`server/discover`, pinned modern never initializes a legacy server, and HTTP
401/403 retain their transport error code and status, 5xx becomes
`EraNegotiationFailed` with its status preserved, and silence becomes
`RequestTimeout`; none become legacy evidence. For stdio, `auto` pays for a
disposable probe child plus the session child on each connection, so servers
with expensive or non-idempotent startup should use an explicit policy. These
getters—not exported latest-version constants—are the authority for the actual
negotiated revision.

Both transports compose client-handler capabilities and `inputRequired`
through one shared normalizer. The absent configuration is deliberately safe:
no client capabilities are advertised, while modern input-required handling is
bounded to `{ autoFulfill: true, maxRounds: 8 }`. An explicit
`inputRequired.autoFulfill: false` preserves the SDK's per-call
`allowInputRequired` manual mode; only duplicated round-cap fields are
ambiguous and rejected with a field-specific error. On reconnect, the first
cursorless tools, resources, resource-templates, and prompts list each bypasses
an otherwise-fresh response-cache entry independently. HTTP roots-change
notifications use the same session-recovery path as requests and check caller
cancellation before each send attempt; completion is not retroactively changed
by an abort that occurs after the notification was sent.

The capability engine currently installs handlers onto a newly constructed SDK
`Client` and returns no handler lease; connection close therefore owns their
lifetime today. Before a host may replace advertised capabilities on a live
client, the engine must make `install` return an idempotent release lease and
each transport must release that lease on invalidation, failed connect, and
terminal close. Production capability advertisement remains disabled until
that ownership hook exists.

Client extensions are host capabilities, not transport defaults. Both explicit
clients start with an empty `McpClientExtensionRegistry`, so the initialize
request omits `capabilities.extensions` unless the host registers an extension.
A registration must name the exact extension contract revision, pass that
contract's strict settings parser, and satisfy its complete-implementation
predicate before the registry will project it. Invalid versions, malformed
settings, duplicate registrations, and incomplete implementations throw; the
registry never advertises a partial implementation or silently drops one.

Registered extension requests are a separate closed dispatch surface: the host
must provide an exact request contract with Standard Schema params/results and
an explicit compatibility predicate for strictly parsed client/server settings.
The registry seals immutable settings and method snapshots before a connection
advertises them; late registration, valid post-connect settings mutation, and
contract mutation cannot diverge dispatch from advertised capabilities. Active
core/lifecycle namespaces and notifications are never eligible for the bridge.
The explicit clients expose this surface only on the exactly negotiated
`2026-07-28` revision; every other revision and unregistered method fails before
transport dispatch. The released client SDK still treats historical
extension methods that collide with retired core vocabulary as core-era methods,
so Brainstrike routes only registered contracts through a non-colliding internal
method and rewrites that method on its owned HTTP/stdio transport immediately
before serialization. Incoming result rewriting is installed before transport
start, follows the SDK's current handler across reassignment, and fails visibly
if a message arrives before the SDK handler exists. This is not an arbitrary
custom-method escape hatch and does not patch the SDK dependency.

The HTTP header bridge (`applyRegisteredExtensionHttpHeaders`) acts only on
registered-extension requests and passes every other request through untouched:
bodiless GET/DELETE, legacy-era core traffic without `Mcp-Method`, and the
SDK's 401/403 re-auth re-sends of core requests. An exclusive extension wire
method (`tasks/get`, `tasks/update`, `tasks/cancel`) is registered by shape
alone. `tools/call` is the one wire method the registry shares with core (the
Tasks result augmentation), so a `tools/call` counts as registered only while
its request id sits in the client's dispatch ledger, which the transport `send`
wrapper fills exactly when it rewrote the internal method (BST-1566 enablement
regression: every desktop stdio/streamable-http connection now carries a
registry, and a core legacy `tools/call` was rejected as a header mismatch). A
malformed or header-disagreeing REGISTERED request still throws.

`RegisteredExtensionDispatchLedger` is that one dispatch state, and it carries
the second fact only the raw-wire seam can see (BST-1596): the unstripped
`notifications/subscriptions/acknowledged` payload for a claimed
`subscriptions/listen` request. The SDK settles `McpSubscription.honoredFilter`
from the CORE `SubscriptionFilter` schema, which drops every extension field, so
an extension lease cannot otherwise learn which ids the server honored. A
consumer claims a capture with `captureSubscriptionAcknowledgement(filter)`
BEFORE calling `listen()`; the bridge's `send` wrapper binds that claim to the
listen request id by filter object identity (the SDK forwards the caller's
filter object untouched), and its incoming hook records the raw payload against
`_meta['io.modelcontextprotocol/subscriptionId']`. The registry still refuses a
contract for `notifications/subscriptions/acknowledged` itself — the SDK
consumes that notification before custom handlers — and this capture does NOT
consume it. Do not add a second dispatch substrate for raw-wire observation;
extend this ledger.

Ledger LIFETIME differs by transport and the ledger is not allowed to care:
stdio allocates one per connection, while HTTP builds its header-preserving
fetch once per CLIENT, so the ledger that fetch queries outlives every transport
the client installs (reconnect, session reset, auth step-up retry each build a
new one). Ownership therefore lives in a per-transport
`RegisteredExtensionDispatchScope` that `installRegisteredExtensionDispatch`
opens, and transport close clears only THAT scope — never the whole ledger
(review of #2928). A shared clear would drop a sibling transport's in-flight
`tools/call` id, and the fetch bridge would then classify it as core traffic and
throw a method/header mismatch, or drop a live subscription claim so the lease
fails as `never observed on this connection`. Subscription ids are JSON-RPC
request ids, which restart on every new connection, so they are unique only
inside one scope; never key raw-wire state by request id at ledger scope.

| Client extension | Canonical contract/settings | Brainstrike host surface | Advertised |
| --- | --- | --- | --- |
| MCP Apps (`io.modelcontextprotocol/ui`) | Stable spec `2026-01-26`; `mimeTypes` is required and its currently defined value is `text/html;profile=mcp-app` | Registered (BST-1572): the default desktop registry, dedicated Electron sandbox startup, generation-fenced resource reader, validated frame bridge, thread-keyed ordinary admission authority (live run, then run-detached host-port execution), and visible-UI IPC consent path form one complete host | Yes by default (stdio, streamable-http); off when either dial says so (BST-1604); sse: not registered |
| MCP Tasks (`io.modelcontextprotocol/tasks`) | Empty capability settings; task results, polling, mid-flight input, durable handles, cancellation, and optional subscription notifications are one complete contract | Registered (BST-1566): `createDefaultMcpExtensionRegistry` installs the exact get/update/cancel, task-result, routing-header, and notification-lease wire contracts on every stdio and streamable-http connection, and `McpDesktopTaskHost` runs the durable repository/lifecycle/interaction/presentation chain per negotiated generation; the legacy `sse` transport gets no registry | Yes by default (stdio, streamable-http); off when either dial says so (BST-1604); sse: not registered |
| OAuth Client Credentials (`io.modelcontextprotocol/oauth-client-credentials`) | Empty capability settings plus complete client-secret or private-key JWT token acquisition and refresh | Disabled: Brainstrike's product path is interactive user authorization, so no machine-to-machine credential host is registered | No |
| Enterprise-Managed Authorization (`io.modelcontextprotocol/enterprise-managed-authorization`) | Empty capability settings plus the complete enterprise IdP/ID-JAG exchange | Disabled: Brainstrike has no managed-enterprise authorization product surface or registered implementation | No |

Migrations 114-115 and `McpTaskRepository` provide the factory-reset-covered,
principal/resource/durable-authority-bound Tasks persistence substrate. This
matches the canonical Tasks contract that a task id is a durable handle and a
client must resume it after restart: [Tasks overview](https://modelcontextprotocol.io/extensions/tasks/overview)
and [SEP-2663](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md).
The repository rebinds the live authority epoch across a Desktop runtime restart
instead of persisting the host's process-local generation. A same-runtime
generation advance rotates the epoch, and every write checks the exact live
epoch/runtime/generation lease in SQL. Because a rotated or retired epoch
orphans its non-terminal rows (`listActive` lists only the live epoch), the
generation must advance only when the server definition is replaced, never on
a transport reconnect, and `McpTaskLifecycle.stop()` retires the epoch only
for `server-removed` and `server-replaced`. A disconnect, restart, or close
leaves the epoch live so the next `openAuthority` rebinds it and `recover()`
resumes the handles; factory reset deletes the rows outright. Draining pollers
and in-flight creates never rejects; a failed retirement rejects `stop()`
without being memoized, so a later `stop()` retries it.

`McpTaskLifecycle` is the sole ordered `tasks/get` poll authority. It persists
each returned handle and its server timing before exposing it, registers
in-flight creates before their first await, resumes only the exact live
authority, and persists before publishing every update. Optional task
notifications carry no state into persistence or interaction: they only wake
and coalesce an immediate lifecycle poll. Interaction consumes the lifecycle's
post-persistence observation callback and never starts a second poll fleet.
Reset aborts and drains registered creates before the authority and task tables
are cleared, so a late insert cannot repopulate a fresh database. If PostgreSQL's canonical JSONB
representation exceeds the durable budget, the lifecycle persists the remote
status plus a bounded blocked diagnostic (field, exact byte count, limit, and
SHA-256) and no raw payload; it publishes neither the rejected remote state nor
an interaction event, so oversized input cannot trigger `tasks/update`. The row
is terminal to local recovery rather than remaining a false-green `working`
handle.
Server replacement, removal, disconnect, reset, restart, lifecycle close, and
caller cancellation abort timers, queued permits, and in-flight requests; a
late stale-authority response cannot publish. The poller rejects a mismatched
task id, terminally exposes the single canonical `maxTransportFailures`
transport-attempt budget, honors
changing `pollIntervalMs`, treats `ttlMs` as a lifetime backstop, and creates no
subscription lease. BST-1561 through BST-1565 built this as opt-in substrate;
BST-1566 registers it in production (see "Production Tasks host" below).

BST-1509 owns the Settings/diagnostics rendering of this matrix and modern
per-request wire proof; the registry remains its host-owned source of truth.

BST-1561 through BST-1563 are opt-in testable substrate only. The wire adapter requires exact
client and server `io.modelcontextprotocol/tasks` advertisement, routes all
three task methods with `Mcp-Name: params.taskId`, and owns one notification
lease per connection on both stdio and Streamable HTTP. The registry owns the
notification method/schema, refuses reserved core notification methods, and
releases the lease on local close, remote close, or rejected closure so retry is
possible. It never emits `tasks/list` or the deprecated request `task.ttl` field.
BST-1596 closes the acknowledgement gap: `listenForMcpTasks` reads the RAW
acknowledgement from the connection's dispatch ledger, not the core-stripped
`honoredFilter`, and a lease whose requested ids were not ALL honored closes
itself and rejects naming the rejected ids — an unacknowledged id can never emit,
so a partially or wholly unhonored lease must never look active. An
acknowledgement the bridge never observed, or one honoring ids outside the
request, rejects the same way; there is no zero-honored-ids success state left.
Real stdio and real Streamable HTTP wire tests cover full, partial, and empty
acknowledgements
(`packages/agent/src/__tests__/mcp-tasks-subscription-acknowledgement.integration.spec.ts`).
Production registration is the BST-1566 layer below.

BST-1564 adds the opt-in interaction coordinator without enabling Tasks in production. It deduplicates
task-scoped input keys and sends elicitation results through `tasks/update` only after shared MCP
validation with exact server, resource, principal, generation, task, and input-key provenance.
`McpTaskLifecycle` is the sole ordered polling authority: it validates exact task identity, persists the
observation, and only then publishes it through the neutral task-observation port. The interaction
coordinator consumes that published stream and never starts a poller. `recover()` is idempotent for
tasks the lifecycle already polls: an active durable record whose id is already tracked is returned
as its existing tracked entry (same `settled` promise) rather than started again, while `start()`
stays strict so one poller per task holds; the desktop host mirrors this by reusing its registered
entry on the card-driven `recover` action. Optional notifications for the
acknowledged ID subset only coalesce an immediate lifecycle poll; lease loss does not disable polling.
Transport exhaustion rejects the public tracked-task settlement and is published to the interaction
failure surface. A `tasks/cancel` acknowledgement is not success: only observed `cancelled` settles
successfully; `completed` or `failed` is a non-cancellation outcome. Each observation treats
`inputRequests` as the complete outstanding snapshot and retires omitted keys before stale responses
can be sent. Task responses keep the merged BST-1561 discriminator ruling (an absent `resultType` is `complete` per final SEP-2322; a conflicting value is rejected). Terminal state, generation replacement, and coordinator close abort pending input and
release resources. Sampling/roots task input remains unsupported (an
`input_required` request with any method other than `elicitation/create`
throws); renderer UX, host registration, and support advertisement are the
BST-1565/BST-1566 layers.

BST-1565's first layer adds an opt-in presentation and control fence; it does
not register Tasks. The browser-safe contract carries one opaque exact handle
(server, resource, principal, generation, and task), status copy, and only the
newest eight of the repository's 32 transition entries. Input/result metadata
never crosses that seam. The separate model projection omits the complete
control identity and is capped at 2,048 serialized UTF-8 bytes, with explicit
truncation. Every recovery or cancellation click revalidates protocol
`2026-07-28`, capability presence, principal, server/resource, and generation
both before and after the owning authority runs. Failures use stable
`stale_handle`, `lost_principal`, `unsupported_version`, and
`capability_removed` diagnostics. The injected authority remains responsible
for atomic repository/lifecycle/interaction fencing; the presentation module
cannot create a task, turn a task handle into synchronous tool completion, or
enable support advertisement.

The final BST-1565 verifier is a test-only lazy renderer mode guarded by both
`mode=mcp-task-harness` and Desktop test mode; a production launch cannot enter
it, and the harness chunk itself exists only in a renderer built with
`VITE_MCP_TASK_HARNESS=1` (the packaged verifier lane,
`test:e2e:lane:packaged-mcp-tasks`, packages with it; release builds never do),
so the harness, its PGlite and migration closure never ship to users. In a
genuinely packaged Electron binary it opens the shared-factory PGlite store
(full engine-extension set) migrated by the real `MigrationRunner` over the
full migration list, a durable authority lease, and the real repository. The first process
persists a lifecycle-owned handle and closes cleanly; a second process over the
same isolated user-data directory rebuilds `restart_required`, recovers through
`McpTaskLifecycle`, and cancels only after `McpTaskInteraction` observes remote
`cancelled`. The packaged proof also exercises lost-principal and stale-
generation refusal, focus behavior, and zero lifecycle polls/tasks/timers,
interaction operations/listeners, and database ownership after explicit close.
This verifier is not a production host adapter; production registration is
`McpDesktopTaskHost`, below, which must never import the harness.

### Production Tasks host (BST-1566)

Extension registration is a host-runtime seam:
`DesktopMcpHostRuntimeDependencies.resolveExtensionRegistry(server, context)`
(defaulted like `resolveClientCapabilities`) runs once per connection
generation and must return a FRESH `McpClientExtensionRegistry` each time — a
registry seals on its first projection, so one instance can never serve two
connections. The production default `createDefaultMcpExtensionRegistry`
calls `registerMcpTasksWireContracts` for `stdio` and `streamable-http` and
returns `undefined` for legacy `sse` (it never negotiates `2026-07-28`, so it
is not advertised rather than advertised-and-refused). The registry is threaded
into both explicit clients' `extensionRegistry` option and into
`McpCoreServerFeatures`, which routes `tools/call` through
`requestExtension(MCP_TASKS_CALL_TOOL_REQUEST_CONTRACT)` whenever the registry
registers Tasks and the server advertises the extension: on the pinned client
a core `callTool` answer with `resultType: 'task'` is rejected by the SDK
funnel, so a task can only arrive on the registered path. That path takes
exactly `{ name, arguments }`; an operation carrying `_meta` or `task` throws.
Both dispatch paths receive the same SDK request options (`onprogress` from the
invoke's `onProgress`, `resetTimeoutOnProgress: true`, the merged signal):
`requestExtension` hands them straight to `client.request`, so progress and the
timeout reset behave identically whichever path the advertisement selects.

`resetTimeoutOnProgress` re-arms the SDK's 60s request timeout on EVERY progress
notification, so only `normalizeMcpRequestOptions`' `maxTotalTimeout` (default
600 000 ms) bounds a chatty server. The CALLER'S SIGNAL is therefore the real
deadline: the agent's per-tool execution guard aborts it when it gives up (see
`docs/agents/assistant-runtime.md`, "Per-tool guard"), which makes the SDK
withdraw the request (`notifications/cancelled`) instead of leaving the POST
open for the remaining absolute budget. Correspondingly, `McpServerActor`
does NOT retire a generation for an `operation`-category failure
(`mcp-request-timeout`, `mcp-input-rounds-exhausted`,
`mcp-list-pagination-exceeded`): those describe the CALL, not the transport, and
retiring on them turned one slow tool call into a server the user later found
disconnected (BST-1594). Every other category still poisons the generation
immediately.

**The one bounded exception is a transport that stops answering at all.**
`mcp-request-timeout` is the only operation code that is AMBIGUOUS — the SDK
gave up WITHOUT an answer, which is what a merely slow server and a wedged
stdio child or black-holed HTTP endpoint both look like — and nothing else in
the actor probes liveness: `onUnexpectedClose` fires only when the transport
actually CLOSES, and there is no ping or health probe. `McpServerActor`
therefore counts CONSECUTIVE unanswered `mcp-request-timeout`s and, at
`MCP_WEDGED_TRANSPORT_TIMEOUTS` (2), INVALIDATES the transport instead of
merely failing the call. Any answer of any kind resets the counter to zero — a
successful result, and equally `mcp-input-rounds-exhausted` or
`mcp-list-pagination-exceeded`, which the server had to respond to produce. A
caller-side cancellation (the agent's per-tool execution guard) never reaches
the counter, because the caller-abort check rejects first; only the SDK's own
request bounds feed it. Invalidation is the state `McpHostService.invoke`
already SELF-HEALS by building a fresh generation on the next call, so a dead
server reconnects on its own rather than staying permanently and silently
`connected`. One slow call still retires nothing. Pinned by
`apps/desktop/src/__tests__/main/mcp-server-actor.test.ts` (both halves: the
retirement AND the streak resets), `mcp-host-service.test.ts` for the self-heal
replacement, and, over a real spawned stdio child,
`apps/desktop/src/__tests__/main/mcp-progress-cancellation.integration.test.ts`.
A later MCP Apps host registers onto the same fresh registry from this seam.
`apps/desktop/src/__tests__/main/mcp-host-runtime-tasks.test.ts` pins that the
real default resolver advertises exactly the support matrix's supported
extension ids, AND that each dial's off state advertises exactly the remainder.

#### Registered extension off switch (BST-1604)

Both registered extensions ship ON; two dials can turn one off without a new
build, and the effective state is `global AND per-server`:

- **Per-server**: an optional `extensions: { apps?: boolean, tasks?: boolean }`
  object in the MCP configuration document, alongside `transport` / `protocol`
  / `auth` / `startup`. An omitted key is enabled; an unknown key or a
  non-boolean value is a config validation error, never a coerced default.
- **Global**: `McpExtensionEnablement` persisted by main under
  `mcpExtensionPreferences.v1` in the `brainstrike-settings` electron-store
  (`apps/desktop/src/mcp/extension-preferences.ts`), reached from the renderer
  over `mcp:extensions:get` / `mcp:extensions:set` and pushed back on
  `mcp:extensions:updated`. A write persists BEFORE it reaches the live host,
  so a rejected write never leaves the process advertising a state the next
  launch would not reproduce. A stored value that cannot be parsed is
  `unreadable` and fails CLOSED — both extensions off — because the stored
  value is the only record of a deliberate opt-out.

`DesktopMcpHostRuntime` folds the global dials into every server's PRIVATE
definition (`applyMcpExtensionPreferences`) before staging, so a flipped dial
changes the affected servers' `configRef` and the replacement runs the ordinary
server-definition path: `taskHost.retired(id, 'server-replaced')` retires the
epoch before the old generation closes, the presenter authority is retired, and
`McpHostService` mints a new generation. A server whose effective state is
unchanged keeps its ref, its generation, and its live epoch — the dial advances
generations only for AFFECTED servers. `setMcpExtensionPreferences` goes through
the same replacement queue as `replaceResolvedConfig` and parses inside it, so a
malformed preference rejects that replacement and leaves the live dials alone.
Nothing mutates a live registry: the registry still seals before a connection
advertises, and the decision is made once per generation.

Disabling is absence, not degradation. With an extension off, `initialize`
carries no `capabilities.extensions` entry for it; with BOTH off the client is
constructed with no registry at all, so `capabilities.extensions` is omitted
entirely and every registered wire method fails before transport dispatch. An
Apps-only registry opens NO task session (`bindTaskHost` is gated on the sealed
Tasks capability), so `McpDesktopTaskHost.track()` still throws naming the
missing advertisement exactly as it does for a server that never advertised it —
that throw is the contract and must not be softened. `sse` remains unregistered
regardless of either dial.

The host snapshot carries the EFFECTIVE per-server state
(`McpHostServerSnapshot.extensions`, transport rule included), which is what the
settings support matrix and the per-server diagnostics render — never the
compiled-in default. The visible renderer subscribes to that snapshot
(`apps/desktop/src/renderer/use-mcp-apps-enablement.ts`) and feeds
`McpAppsEnablementProvider`, so turning Apps off unmounts every mounted app for
that server through its ordinary teardown (frame bridge close, tool-call
authority close, generation retirement, sandbox shell release) and the run-
detached admissions drop on the generation change the same replacement caused.
Factory reset clears the stored dials and returns the runtime to the shipped
default; a failed reset restores the captured dials with the rest of the
snapshot. Pinned by
`apps/desktop/src/__tests__/main/mcp-extension-preferences.test.ts`,
`ipc-mcp-extensions.test.ts`, `mcp-host-runtime-tasks.test.ts`,
`packages/mcp-app-host-ui/src/__tests__/mcp-app-tool-result.test.tsx`, and the
real-wire absence proofs in
`packages/agent/src/__tests__/mcp-modern-stdio-extension.integration.spec.ts`
and `mcp-modern-http-extension.integration.spec.ts`.

`McpDesktopTaskHost` (`apps/desktop/src/mcp/task-host.ts`) implements the
agent runtime's `McpTaskTrackingCapability` and the host runtime's connection
observer. It is constructed by `DesktopMcpHostRuntime` (exposed as
`runtime.taskHost`) and threaded by `apps/desktop/src/assistant-server.ts`
through `initializeAgentStream({ mcpTaskTracking })` →
`AssistantStreamRuntimeOptions.mcpTaskTracking` →
`MastraAgentRuntimeOptions.mcpTaskTracking`, exactly like `mcpHost`. Per
connected generation whose negotiated capabilities advertise
`io.modelcontextprotocol/tasks` on `2026-07-28` it composes `McpTaskRepository`
over the existing desktop database (`db-main.getDatabase()`, never a new
PGlite), one `McpTaskObservationPort`, the sole-authority `McpTaskLifecycle`,
and `McpTaskInteraction`, and runs `recover()` so every non-terminal handle of
the live epoch resumes. A server that does not advertise Tasks opens no session
and `track()` throws naming the missing advertisement. The actor client closes
the task session (`stop('disconnect')`) before the transport; a replaced
private definition retires the epoch (`stop('server-replaced')`) and a removed
server `stop('server-removed')` before the old generation closes, while an
enabledTools-only reload is a plain reconnect (same `configRef`, same epoch).
Retirement happens only AFTER the replacement configuration has been staged
(`stageResolvedConfig`: auth projection for every server): a replacement whose
preparation rejects (e.g. a bearer credential that cannot be inspected) leaves
the old actor connected with its Tasks session intact. Retirements of distinct
servers are independent sessions and run concurrently; any failure aggregates
into the rejected replacement. The card-driven `recover` action reuses the
host's registered entry for any id the lifecycle already polls (lifecycle
recovery is idempotent, see above), so recovering one card never fails because
another task on the same server is live.

Handle derivation (`McpTaskHandle`): `serverId` is the configured server id
(`ResolvedMcpServer.name`, equal to the host snapshot's `configuredServerId`);
`resource` is the canonical server URL (fragment stripped) for streamable-http
and the reserved marker `https://stdio.mcp.brainstrike.invalid/` for stdio (the
repository requires a canonical HTTP(S) URL and a child process has no
protected resource); `principalId` is `none`, `bearer:<credential id>`, or
`oauth-user:<resource>|<sorted scope key>` for streamable-http and
`local-process` for stdio; `authorityEpoch` is minted/rebound by the
repository. The repository's `connectionGeneration` is a host-owned
*definition* generation that advances only when `configRef` changes (or after
a retirement), never on the host's per-actor generation, so a transport
reconnect rebinds the live epoch instead of orphaning its rows.

`awaitSettlement(handle, { timeoutMs, signal })` resolves
`{ settled: false, reason: 'timeout', task }` at the bound and never throws for
a timeout; it rejects for an unknown handle, a handle outside a live session,
a lifecycle stop, or observation exhaustion. Task-scoped `input_required`
elicitation cannot use `runWithOperation`: the presenter's single-matching-
operation guard has nothing to bind outside a `tools/call` and would misattribute
provenance during a concurrent one, so the host binds each tracked task through
`McpElicitationPresenterAuthority.bindTaskPresenter({ configuredServerId,
generation, operation: { type: 'tools/call', target: toolName } })`, a separate
authority that skips the operation registry, validates the live generation, and
is released on settlement. One notification lease exists per connection and is
fixed at subscription time, so the interaction subscribes for the ids known when
it starts (recovered handles or the first tracked task); later tasks in the same
generation are admitted and driven by the authoritative poller alone, logged at
info level.

Renderer seam (`apps/desktop/src/mcp/task-bridge.ts`, mirroring the
elicitation bridge): `mcp:task:status-changed` pushes every presentation change
to tracked visible-UI windows, `mcp:task:list` returns the bounded live
presentation set, and `mcp:task:act` runs one card action through the
presentation controller fence; both invokes carry the visible-UI sender policy.
The preload exposes `window.mcp.tasks` (`McpTaskBridge`) on the visible-UI
preload only; hidden hosts never receive the `mcp` global. The support matrix
row for Tasks is `supported` (BST-1566) and the settings-ui matrix pin and the
desktop truthfulness test change together with it.

### MCP client input and deprecated compatibility (BST-1470)

Core client capabilities are installed through the one `McpClientCapabilityRuntime`
used by both explicit HTTP and stdio clients. The runtime projects a capability
only when its complete handler is present; no handler means no declaration and
an inbound request fails through the SDK's missing-capability path. Modern
`input_required` and legacy pushed requests dispatch through those same SDK
`setRequestHandler` registrations. Automatic fulfillment is enabled with a
Brainstrike cap of eight rounds (below the SDK's ten-round ceiling), so the SDK
keeps opaque `requestState`, cancellation, request metadata, progress, and the
originating tool call/approval context on one invocation. Round exhaustion and
malformed requests stay visible SDK errors.

The desktop host's production capability resolver (BST-1584) advertises exactly
`{ elicitation }` — form and URL modes backed by the process-local presenter
authority through `createMcpElicitationCapability(elicitationPresenter.presenter)`
with the default `https-only` URL policy — so both HTTP and stdio constructor
option objects carry `clientCapabilities.elicitation` for every connection.
Roots, sampling, and protocol logging remain absent. An explicit
`resolveClientCapabilities` dependency (the conformance client injects its own)
replaces this default wholesale; a resolver that returns `undefined` yields
capability-free options exactly as before. The input-required policy stays the
SDK automation policy `{ autoFulfill: true, maxRounds: 8 }`, so a modern
`input_required` round dispatches through the same presenter as a legacy pushed
`elicitation/create`.

Desktop main owns one process-local elicitation presenter authority. An explicit active-invocation
registry binds only a single matching server operation and rejects ambiguous concurrency; no async
context or untrusted MRTR `requestState` supplies authority. Grants are weak, settlement is once-only,
and actor retirement covers failure, replacement, reset, disconnect, and close.

The consent surface is one IPC seam plus one app-wide modal:

- `apps/desktop/src/mcp/elicitation-bridge.ts` attaches the presenter's single
  listener once per `registerMcpIpcHandlers` lifetime and broadcasts every
  presentation (`mcp:elicitation:requested`) and every finalization
  (`mcp:elicitation:retired`, `{ id, code }` — settlement, caller abort,
  generation retirement, detach, close) to every live `BrowserWindow`. The
  renderer answers through the `mcp:elicitation:settle` invoke; the payload is
  parsed by `parseMcpElicitationSettlement` (`@brainstrike/assistant-contract`,
  strict keys, `content` only with `accept`, safe-integer `generation`) before
  it reaches `settle()`, and presenter failures surface as a code-only
  `McpElicitationBridgeError` — no cause detail crosses the bridge.
- Detaching the bridge (handler unregistration) rejects every pending
  presentation with `mcp-elicitation-presenter-unavailable`; with no listener
  attached an inbound request fails closed the same way. There is no auto-accept.
- `McpElicitationHost` (`@brainstrike/settings-ui`, mounted app-wide in
  app-shell's root layout beside the shell routes) resolves the three bridge
  members by capability, queues presentations oldest-first, and renders one
  `McpElicitationDialog` at a time. The dialog is non-dismissible (no corner
  close, Escape and outside clicks ignored), names the provenance in its
  accessible title/description (server identity, website origin, operation and
  target, transport, negotiated revision), renders the restricted form schema
  with labelled controls and a client-side mirror of
  `validateMcpElicitationResult` (never a replacement — main and the SDK
  re-validate), shows a URL request's full URL verbatim, and focuses Decline
  by default. Accept on a URL request records a one-use grant; only main opens
  the browser, and only after that accept. A retired presentation swaps the
  actions for an explanation naming the code plus Dismiss.

Elicitation has independently declared form and URL modes. The host presenter
must render the SDK-validated restricted form schema and return exactly
`accept`, `decline`, or `cancel`; the SDK validates accepted content against the
requested schema before retry. URL requests are bounded, restricted to HTTP(S)
without embedded credentials, shown to the presenter in full, and opened only
after its explicit `accept`. Decline/cancel never call the external opener.

Roots, sampling, and protocol logging are compatibility-only and independently
disabled by omission for every server. Enabling roots requires a snapshotted
list of explicit `file:` URIs from the mounted-workspace/server configuration
authority. Roots are advisory hints, never filesystem grants, and
`listChanged` is advertised only when the caller also owns change emission.
Sampling requires an explicit per-server handler; no handler means the
capability is structurally absent. The handler receives only the server's
validated sampling request and the outer abort signal, so a product adapter
must use the already-selected Brainstrike provider/model and limits and must not
append conversation history. Protocol logging requires an explicit minimum
level and sink; entries are capped at 32 KiB, sensitive-key values are redacted,
and remote `logger`/data fields remain payload under the fixed local server
scope rather than becoming Brainstrike logger scopes.

These three surfaces were deprecated in MCP `2026-07-28`. Review them for
removal on 2027-07-28 (the specification's earliest-removal boundary); each can
be removed or disabled without changing elicitation or the other compatibility
surfaces.

MCP Apps may register only after one reviewed implementation proves every
graduation gate together: supported MIME declaration, `ui://` resource loading,
tool/result association, isolated sandbox and enforced CSP, validated
bidirectional messages, permission/consent, lifecycle cleanup, and renderer
tests. A partial or text-only host never advertises the extension.

BST-1571 adds the still-unregistered app-originated `tools/call` authority.
`McpAppToolCallAuthority` accepts only app-visible tools owned by the exact
server generation, holds every `ask` decision until its opaque host consent id
is approved, and releases provenance on denial, cancellation, failure, or
close. Each call also receives an authority-generated, generation-bound
preparation id and a required release callback before preparation starts. The
authority awaits that one-use release before settling denial or cancellation,
including cancellation after a broker prepared the ordinary executor but before
its response arrived. The `@brainstrike/agent` runtime captures an Apps admission capability
from its post-plan/post-permission/post-storage tool map. The preparer accepts
that admission capability instead of policy or invocation inputs, so it cannot
recreate or bypass ordinary admission or pair one decision with another
server/action executor. Admission returns an opaque one-use executor bound to
the exact post-gate tool entry and exact server/tool identity. The executor is
captured before artifact/model projection; a private in-memory marker on the
authority-owned abort signal preserves the complete App-facing
`CallToolResult` through the transport and temporary preview wrappers,
including canonical server-domain errors with `isError: true`, their content,
and `_meta`. Only transport/execution failures enter the ordinary guard's
sanitized error wrapper. Calls
absent from the ordinary map fail visibly; admitted calls use the already-bound
guard, Pre/PostToolUse hooks, and execution-duration telemetry exactly once,
and replay fails before a second execution. Apps telemetry contains only tool
name, outcome, and duration—never input, output, or app context. This is
infrastructure, not capability graduation: production Apps registration and
advertisement remain disabled; BST-1572 owns release enablement.

The BST-1571 host surface lives in the browser adapter package
`@brainstrike/mcp-app-host-ui` inside assistant-experience, not in the shared
foundation UI layer and not as a global or auto-mounted renderer. The
`@brainstrike/mcp-app-host` core remains NodeNext-compatible and React-free, so
agent-side Apps authority imports do not load renderer code. The surface's
closed state union renders loading, ready, sanitized error-code, cancelled, and
completed states without accepting raw error text. App-originated `ask` calls
render one focus-trapped `alertdialog` at a time, expose only the owned tool
name and risk category, and never render arguments or results. Allow and Deny
act on the authority's opaque consent id; tab/shift-tab stay inside the dialog,
Escape denies, and settlement restores focus to the host-provided recovery
target. The sandbox slot is inert and hidden from assistive technology while
consent is open. This surface still does not register or advertise MCP Apps in
production.

The BST-1571 packaged verifier launches the exact electron-builder output,
queries the live main process for `app.isPackaged === true`, and drives its
dedicated verifier window over Chromium CDP. That window composes the production
provenance authority, object-URL sandbox owner, opaque frame bridge, tool-call
authority, and accessible host surface. The sandboxed fixture uses the pinned
SDK's `App` and `PostMessageTransport` and validates the canonical initialize
result. A sibling dedicated sandbox WebContents proves the packaged Electron
policy denies popup escape and that lease teardown destroys that WebContents;
the policy is deliberately not attached to the host renderer, where it would
block the host-owned object-URL frame. App-originated `tools/call` traffic
crosses the real frame listener and reaches a loopback HTTP request/response;
host RPC responses return to the app. Completion, replacement, disconnect,
shutdown, denial, server failure, protocol failure, and timeout must release all
frames, object URLs, RPC callbacks/timers, consent listeners, calls, HTTP
requests, sockets, and the packaged child process. The verifier-only loopback broker
keys each prepared executor by the authority preparation id; execute or explicit
release consumes exactly that entry. Repeated denial and prepare-response
cancellation assert zero pending entries before generation teardown, so the
generation-wide release remains only a final shutdown assertion. Production uses
the IPC authority below and never imports this E2E implementation.
The `Native Electron Package` job runs this proof through
`test:e2e:lane:packaged-mcp-apps` against the artifact it just built.

### Production Apps host (BST-1572)

`registerMcpAppsClientCapability` defines the capability-only
`io.modelcontextprotocol/ui` contract at stable revision `2026-01-26`. It has
no extension requests or notifications and works on legacy-era connections.
`createDefaultMcpExtensionRegistry` registers it beside Tasks on every fresh
stdio or streamable-http generation; legacy `sse` receives no registry.
Initialize advertises exactly
`{ mimeTypes: ['text/html;profile=mcp-app'] }`.

**Sandbox boundary (settled; do not reintroduce a partition).** The app is an
in-page nested iframe in the main window; Electron never creates a WebContents
for an in-page `<iframe>`, so a `web-contents-created` / session-partition
policy can never observe it (the earlier `mcp-app:thread` wiring was dead code
and was removed). The boundary is: an opaque-origin `about:srcdoc` app frame
with `sandbox="allow-scripts"`, a per-document CSP meta tag, and `allow` set
to `'none'` for every reviewed permission — created by a host-authored shell
that the renderer renders (`McpAppSandboxOwner.open` → `renderMcpAppSandboxShell`)
and registers over `window.mcp.apps.prepareShell`. Main serves the shell at
`brainstrike-mcp-app://<token>/` (`apps/desktop/src/mcp/apps-shell-protocol.ts`:
privileged `standard: true` scheme → one origin per shell, never the host
origin; the app policy delivered as `Content-Security-Policy` AND
`Permissions-Policy` RESPONSE HEADERS, which the nested srcdoc inherits;
uniform 404 for unregistered/released tokens, 405 for non-GET; exempt from the
`setup-security` header stamp like `brainstrike-canvas:`; registered in the
single `registerSchemesAsPrivileged` call). The main window's CSP is
`frame-src brainstrike-canvas: brainstrike-mcp-app:` — `blob:` is never a
frame source. Shells are bound to the registering WebContents id
(`apps-shell-bridge.ts`: only that sender may release; destruction drops all
of its shells) and `releaseShell` is immediate. The renderer reaches the app
frame as the cross-origin shell's first child window (`frame.contentWindow[0]`);
the shell document is unreachable. `will-frame-navigate`
(`apps-frame-navigation.ts`, wired in `create-window.ts`) denies the shell any
navigation and the app frame anything but `about:srcdoc`.

**Session policy (BST-1599).** `allow` + `Permissions-Policy` only govern
Permissions-Policy features; `notifications` is not one, and with no session
handler Electron 43 GRANTS it to the opaque app document by default.
`installMcpAppSessionPolicy` (`apps/desktop/src/mcp/apps-session-policy.ts`,
wired from `setup-security.ts` onto `session.defaultSession`) denies every
permission request AND check whose `details.requestingUrl` is an opaque-origin
sandbox shell (`brainstrike-mcp-app://` or the Canvas shell
`brainstrike-canvas://`), or is `about:srcdoc` while the requesting WebContents
hosts an `about:srcdoc` frame parented by such a shell. Electron exposes no
frame handle and no usable origin for the opaque app document, so the srcdoc
arm resolves the parent from the frame tree and is fail-closed; both sandboxes
are covered because Electron cannot say WHICH srcdoc frame asked, and covering
only one would make the other's posture depend on whether an MCP App happened
to be mounted. `details.requestingUrl` is REQUIRED on the request handler but
OPTIONAL on the check handler (Electron omits it for cross-origin sub frames —
exactly what the sandbox is) and APIs that check before requesting never reach
the request handler, so an unattributable SUB-frame check is DENIED whenever
the WebContents hosts a sandbox frame; `details.isMainFrame` keeps the host
renderer's own checks on Electron's default. Denials log at `warn` once per
(WebContents, arm, permission): untrusted content can read permission status in
a tight loop, and the log is on the user's disk. `will-download` cancels any
download whose URL chain carries an MCP App shell origin
(`brainstrike-mcp-app://…` or the `blob:brainstrike-mcp-app://…` a shell frame
minted); the app document itself cannot reach `will-download` because its
sandbox is exactly `allow-scripts`, and neither can either Canvas layer, which
is why the download arm stays MCP-App-only. Every other requester keeps
Electron's default outcome, so the host renderer, the hidden renderer hosts,
and the browser pane's own partition (`browser/browser-session.ts`) are
unchanged. Pinned by
`src/__tests__/main/mcp-apps-session-policy.test.ts` and a live probe in
`test:e2e:lane:packaged-mcp-apps` that drives both the request and the check
path.

`McpDesktopAppHost` owns ordinary admission in main, keyed by the OWNING
THREAD. `assistant-server.ts` registers each runtime's `mcpAppToolAdmission`
as `{ runId, threadId: runtimeData.memory.threadId }` — a run without a
persisted thread publishes nothing — and calls `invalidateAdmission` from
runtime disposal. `McpAppPrepareRequest.threadId` is mandatory: the shared
`ToolResultRendererProps.threadId` seam (populated in `todo-progress.tsx` from
`ActiveThreadKeyContext`, the same id the request lifecycle sends as
`memory.threadId`) carries the thread that owns the tool result, and
`McpAppToolResult` renders a visible "requires a persisted thread" note instead
of mounting when it is absent. Preparation resolves the admission of exactly
that thread and requires it to admit the requested server; it never picks by
recency, so two threads on the same server each execute under their own run's
approval/risk state. It binds the one-use executor and release to the
requesting WebContents plus preparation id and fails closed with
`mcp_app_admission_unavailable` otherwise. A newer run registering for the
same thread supersedes the older admission (live or detached) and releases its
pending preparations; a later disposal of that older run leaves the newer one
intact. Registration is gated on the run being able to mount an app at all:
`createMcpAppToolAdmissionCapability` counts admitted tools whose execution
metadata carries the `appCapable` marker (set in `mcp-runtime-client.ts` from
the same `_meta.ui` predicate as the Apps projector), and `agent-runtime.ts`
skips `mcpAppAdmission.register` when that count is zero. Consequence: an
app-free later run of the same thread does NOT supersede the thread's
still-mounted app admission, and it never detaches into a host watch (the
packaged lifecycle E2E's `subscriptionsClosed: 1` pins this).

**Admission lifetime: live run → detached → superseded/retired** (BST-1572
acceptance: the user reads the rendered app and clicks a button AFTER the
assistant's turn ended). While the run is live, the admitted executor is the
run's exact gated MCP tool entry (hooks, telemetry, run-owned
`McpRuntimeClient`). Run `dispose()` closes that client, so the authority does
NOT keep executing through it: `invalidateAdmission` releases the run's
pending preparations and DETACHES the admission. The admission capability's
`admit` reads only the static per-tool maps built at runtime assembly
(`createMcpAppToolAdmissionCapability`: decision from `askTools`, risk from the
permission snapshot, tool identity namespace-resolved through `toolNameMap` to
the server-side name) and touches no client, so a detached prepare returns the
same `allow`/`ask` decision and risk category — the renderer consent dialog
still gates `ask` tools exactly as before. Detached execution is one
process-level host-port call,
`host.invoke({ type: 'tools/call', configuredServerId, toolName, arguments }, { signal })`
on `getDesktopMcpHostRuntime().host` (the app's `toolName` is already the
server-side name; `origin.serverId` is the configured server id), and the
canonical `CallToolResult` is what the renderer posts back into the frame.
When a Tasks-capable server answers a detached call with a CreateTaskResult
(detected with `readMcpCreatedTaskResult`, which unwraps the registry envelope
too), the authority hands it to the desktop task host through its lazily
resolved `resolveTaskHost` seam (`getDesktopMcpHostRuntime().taskHost`) so the
repository/lifecycle/lease own the task, then returns the canonical
CreateTaskResult to the frame without awaiting settlement — the same shape the
run-owned app path returns (see "TOOL-PATH WIRING (BST-1566)" in
`assistant-runtime.md`). A task the host cannot track fails the call visibly.
Detached calls bypass the run's tool hooks, guard/error processors, and
telemetry by design: there is no run. Retention is bounded: at most one
admission per thread; a detached admission is pinned to each admitted server's
live host generation at detach time (servers not live on the host are not
retained; an admission with none is dropped), a `host.watch` on those servers
drops it when a generation retires or the server disappears, and prepare
re-checks the live snapshot generation because watch delivery is
microtask-queued. Host close rejects the invoke (`mcp-host-closed`) rather than
degrading. There is no app-unmount signal today, so a detached admission lives
until supersession or generation retirement. Execution, explicit release, run
disposal, supersession, generation retirement, and WebContents destruction
consume preparations; stale and replayed preparation ids cannot execute.

The renderer supplies the preparation id and preparation awaits the admission
preparer, so `prepare` reserves the id SYNCHRONOUSLY before its first await
and drops the reservation on every exit path: a concurrent duplicate rejects
with `mcp_app_preparation_duplicate` instead of overwriting the first entry
(whose executor would otherwise be dropped without release).
The visible-UI-only IPC domain is `mcp:apps:prepare`, `mcp:apps:execute`,
`mcp:apps:release`, `mcp:apps:prepareShell`, and `mcp:apps:releaseShell`
(`McpAppShellPrepareRequest` = `{ contentSecurityPolicy, document,
permissionsPolicy }`, result `{ shellUrl, token }` with the URL pinned to the
token root on the shell scheme). `window.mcp.apps.readResource` resolves the server's live
generation and uses the existing `mcp:content:readResource` path for the exact
server id and `ui://` URI, then requires text content and the exact Apps MIME
type. Hidden preloads expose no `mcp` global. Renderer consent remains owned by
`McpAppToolCallAuthority`; main executes only the ordinary runtime's already
gated tool entry.

BST-1567 owns the disabled Apps wire-contract projection from the immutable
`@modelcontextprotocol/ext-apps@1.7.5` schema and stable `2026-01-26` spec. It
accepts all 15 stable `ui/*` methods plus `tools/call`, `resources/read`,
`notifications/message`, and `ping`; package-only `ui/download-file` and
`ui/notifications/request-teardown` are rejected. The package schema defines
empty `ui/resource-teardown` params while the prose example includes a reason.
Brainstrike follows the machine schema and rejects the reason-bearing variant
until upstream reconciles the conflict. `ping` and `tools/call` are accepted
in both directions (either peer may ping; the host calls an app-declared
tool). JSON-RPC uses string or safe-integer IDs, exact envelopes, one-shot
correlation, 256 pending entries, 256 KiB messages, depth/node caps,
2,048-character URIs, and 32-entry/64 KiB metadata. An error response may
carry `id: null` as JSON-RPC 2.0 §5 requires when the responder could not read
the request id; it parses (for diagnostics) but never settles a pending
request. The correlator releases a slot when the reply to it fails validation,
exposes `cancel(id)` for an abandoned request (timeout, abort, send failure),
and `clear()` for transport close, so a misbehaving app cannot wedge the
256-entry bound. The parse-time size bound is defense in depth: the bridge
layer (BST-1570) bounds raw `postMessage` payloads before parsing. These inert
parsers do not register Apps support or provide resource, sandbox, frame, or
consent behavior.

BST-1568 adds the next disabled contract layer: one in-memory provenance
authority issues opaque handles for an authenticated server identity and its
monotonic connection generation. Tool `_meta.ui`, effective app/model
visibility, associated resource, tool input, and tool result remain attached to
that authority-owned generation. A replacement generation retires every prior
handle; duplicate tool names and concurrent type-sensitive request IDs fail
closed within the generation. `retireGeneration` is the explicit teardown for a server that disconnects
without a replacement; it keeps the latest generation number so a reconnect
must open a strictly greater one. A resource's `_meta` is read like a tool's:
`ui` is parsed when present and namespaced sibling keys are ignored. A settled
tool result carries the audience that issued the call. Resource resolution requires the owning tool and
generation,
the exact associated `ui://` URI and Apps MIME type, exactly one non-empty text
or canonical base64 body, fatal UTF-8 decoding, and at most 1 MiB decoded HTML.
Result settlement is one-shot. This authority does not infer ownership from a
URI or tool name and does not register Apps, fetch resources, render content,
or implement a frame, sandbox, consent, or approval path.

BST-1569 adds the disabled renderer boundary. One host-owned object URL contains
a shell whose only child is an opaque-origin `srcdoc` iframe with
`sandbox="allow-scripts"`; same-origin, popup, download, top-navigation, form,
object, and worker privileges remain absent. Validated Apps metadata constructs
the resource CSP (each declared source is rejected if it carries a CSP
delimiter or quote), and the shell carries that policy verbatim: the srcdoc app
inherits the shell's policies and CSP combination only narrows, so a shell
policy tighter than the app's would deny the app its declared sources, while
Chromium exempts the srcdoc load itself from `frame-src`. The host owns the
doctype so the app renders in standards mode with the CSP ahead of its bytes.
Requested camera, microphone, geolocation, and clipboard permissions are
recorded rather than granted until a later consent contract exists. Each owner permits at most eight active frames and 4 MiB of retained
shell HTML; the prior provenance layer independently caps decoded HTML at 1 MiB.
The Electron adapter requires a dedicated session, denies window creation,
navigation, redirects, webviews, downloads, and all permission checks/requests.
Session-scoped denials are installed once per session and never restored to
Electron's permissive defaults (a lease's close cannot fail a sibling open);
teardown removes the per-WebContents hooks, destroys the WebContents, clears
session cache/storage once the last lease closes, and revokes the owner URL.
Installation is failure-atomic: a partial hook registration closes the
WebContents and rolls back every per-WebContents listener (session denials
installed so far stay, and a retry installs only the missing ones); when the
rollback itself fails, `McpAppElectronSandboxInstallationError` carries a
`cleanup` lease that retains ownership. Teardown is retryable: each step
records its own success, failures aggregate into one error, per-WebContents
hooks are released only after the WebContents closes, and URL revocation keeps
frame and retained-byte ownership until it succeeds. Real Chromium and Electron adversarial
verifiers pin those boundaries and repeated cleanup; the Chromium verifier is
a `*.browser.test.ts` file run by the package's `test:browser`
script in the Browser tests lane (Playwright image), never in the Unit lanes. Nothing registers this
sandbox, advertises Apps, or implements app RPC, consent, or production UI.

BST-1570 adds the still-disabled frame bridge. A bridge binds exactly one
opaque-origin frame source and one live monotonic generation, requires the
`ui/initialize` response plus `ui/notifications/initialized` handshake before
normal dispatch, and applies the stable Apps/standard message parsers in both
directions. Source or origin mismatches are reported and ignored without giving
an unrelated frame a teardown primitive; malformed, unknown, replayed, or stale
traffic from the bound frame fails that channel closed. Requests and
notifications use bounded pending sets, owned deadlines and abort listeners;
request IDs are type-sensitive and one-shot, and correlated errors are safe.
Every successful response is validated against the exact originating request
method before it is posted or settles a correlated caller. The mapping uses the
pinned Apps result schemas for initialize, link, message, display-mode, and
teardown requests, plus the pinned MCP Core result schemas for `tools/call`,
`resources/read`, `ping`, and the empty `ui/update-model-context` result; there
is no generic-record success path.
Replacement, disconnect, close, or a bound-frame protocol failure aborts every
inbound callback, rejects every outbound request, clears every timer, removes
the message listener, and retires all request IDs. Real opaque-origin Chromium
and electron-builder-packaged Electron verifiers pin replacement, failure,
disconnect, and close quiescence; the packaged verifier asserts
`app.isPackaged === true`. This bridge still does not own resources or consent,
register Apps support, or expose a production renderer surface.
The packaged Electron verifier for the bridge runs only through
`test:e2e:lane:packaged-mcp-apps-bridge` in the Native Electron Package job;
its harness document lives in the disposable user-data directory and imports
the bridge module by absolute file URL, never from a published `dist/`.

Desktop Settings consumes the singleton `DesktopMcpHostRuntime`'s browser-safe
`McpHostSnapshot` through `mcp:status:get` and revisioned
`mcp:status:updated` events. Renderer state accepts only strictly newer
revisions, tool presence never implies connection success, and connected or
failed zero-tool servers plus negotiation/config errors remain visible.

Startup policy is explicit per configured server: `automatic` permits one
bounded machine connection attempt during discovery, while
`authentication-required` publishes an actionable status without constructing
the transport when no reusable native OAuth credentials are stored. A stored
native HTTP OAuth grant starts disconnected and participates in app-load tool
discovery, reconnecting with the existing SDK token/refresh flow under the
ten-second machine deadline. This automatic attempt cannot open a browser;
only explicit host controls grant interactive authorization to the provider.
If login is needed, the attempt closes its transport/provider and returns to
authentication-required, without retrying on every assistant request. Its safe
error directs the user to Settings > AI Tools instead of a generic actor error.
`connect`, `retry`, `cancel`, `disconnect`, and `reauthorize` are explicit host
controls; user-paced authorization is not governed by the automatic ten-second
machine deadline. An explicit Connect arriving during a background attempt reuses
its success, or continues an authentication-required failure with a fresh
interactive provider after cleanup. It never retries cancellation, transport, or
cleanup failures. Omitted connection modes use the same non-interactive deadline
and provider policy as explicit false. Auth projection is awaited during config
staging before actor construction. Stdio stderr is piped through the SDK's
early-created stream, line-bounded and secret-redacted before it reaches the
server snapshot. Healthy stderr remains a session-only debug signal. On connect
failure or unexpected child exit, the host emits at most one durable `warn` per
server generation containing only the last five sanitized diagnostics plus an
honest omitted count; the per-server snapshot remains a 20-entry session ring.
Raw child stderr never enters either path.

Remote transport rules:
- `stdio` constructs only the official SDK's `StdioClientTransport`. The SDK
  inherits its documented safe environment allowlist and overlays only the
  explicitly configured `env`; spawn/connect failures remain visible. An
  unexpected child exit invalidates only that owned connection: the interrupted
  request fails without replay, and the next operation may start a fresh child.
- `streamable-http` is the modern MCP transport and normally targets one `/mcp`
  endpoint. It constructs only the official SDK's
  `StreamableHTTPClientTransport`.
- `sse` is the deprecated HTTP+SSE compatibility transport. It constructs only
  `SSEClientTransport`, even when its URL ends in `/mcp`.
- Interactive OAuth completion (`authorizationCallbackSource`) and OAuth scope
  step-up (`maxStepUpRetries`, `onInsufficientScope`) are Streamable-HTTP-only.
  Configuring any of them with `transport: "sse"` throws at client construction
  naming the unsupported combination; the SSE transport never silently drops
  them. Adding either capability to legacy HTTP+SSE is out of scope (BST-1605).
- `authorizationCallbackTimeoutMs` only ever applies while building the
  interactive completion, which a missing `authorizationCallbackSource` skips,
  so passing it alone throws on EVERY transport rather than being accepted and
  ignored. The guard is not SSE-specific: the same orphan option on
  `streamable-http` is refused for the same reason.
- There is NO automatic Streamable HTTP → SSE fallback. The MCP specification
  describes that fallback as an OPTIONAL compatibility strategy for ambiguous
  URLs; Brainstrike removes the ambiguity by requiring the user to select the
  transport. A 400/404/405 initialization failure therefore remains visible.
- Both HTTP variants share strict HTTP(S)-URL, no-embedded-credentials, header,
  secret-decryption, cancellation, progress, and lifecycle behavior.
- External bearer auth is desktop-main-only and reference-based. JSONC carries
  exactly `{ type: "bearer", credential: { store: "mcp-credentials", id:
  <uuid> } }`; the UUID maps to the `mcp-credentials:<uuid>` slot in the
  existing safeStorage-encrypted `SecretsService`. The renderer-visible host
  snapshot projects only `malformed | missing | stored | unreadable`. Its
  initial projection enumerates storage keys without decrypting credentials;
  the final owned fetch boundary validates the token and publishes the current
  state back to the actor snapshot. The credential authority resolves the
  token for every owned HTTP request and injects
  `Authorization: Bearer …` only after proving that the request origin equals
  the configured resource origin and that no competing Authorization header
  exists. The host runtime, config projection, actor context, status, logs,
  diagnostics, and errors receive no token. Missing, unreadable, malformed,
  cross-origin, and conflicting-auth states fail with fixed codes and static
  messages; no fallback to unauthenticated transport occurs. Ordinary
  disconnect closes the transport but retains the externally managed secret.
  Factory reset clears the shared SecretsService, and request-time resolution
  means no connected fetch closure can retain the cleared bearer.
- HTTP lifecycle ownership is explicit. `client-owned` connections invalidate,
  close, reconnect once, and replay only a reconnectable session failure.
  `host-owned` connections invalidate and close locally without replay; the
  triggering operation keeps its original transport failure, new operations
  may create a fresh connection, and the host receives one isolated
  `onUnexpectedClose` notification. Observer throws and asynchronous
  rejections are diagnosed without replacing the transport failure. Explicit
  `close()` remains idempotent and owns all final local/session cleanup.

Both explicit clients install the shared client-capability engine before each
connection opens; desktop production supplies the presenter-backed elicitation
resolver above, and any other capability still requires an explicit resolver.
Each connection owns the returned lease and
closes it with the transport: active legacy pushed-handler work is aborted,
handlers are removed, settlement is awaited, and cleanup failures remain part
of the transport's aggregate close result. URL elicitation is validated by one
host assertion before consent and before opening: HTTPS without credentials is
the production rule, while HTTP requires the explicit loopback-development
policy. Accepted form content is host-validated for the SDK's `email`, `uri`,
`date`, and `date-time` formats. Arrays remain limited to the SDK's
enum/multiselect schema; unconstrained arrays are rejected by the SDK ingress
schema.

Final SEP-2322 defines an absent `resultType` as `complete` for backward
compatibility. Stable `@modelcontextprotocol/client@2.0.0` instead rejects that
shape on a 2026 connection, so both explicit transports install one immutable
pre-codec mapping for the absent discriminator. It applies only to positively
modern messages (pinned 2026, or `auto` after the SDK reports a negotiated
modern era), never mutates the parsed message, and leaves explicit core or
extension result kinds untouched for the SDK to validate. Before negotiation,
transport classification can positively identify modern traffic; otherwise
unclassified `auto` and legacy messages remain unchanged. Installation preserves
and delegates through the transport's existing `onmessage` descriptor, composes
both the SDK probe and production handlers, and recognizes probe-detach wrapper
restoration without stacking or recursion. A second installation with a
conflicting protocol or negotiated-era resolver fails visibly. Retire this
mapping only when the pinned SDK implements
the final SEP rule and the official `sep-2322-client-request-state` scenario
still passes.

Ownership and flow:
1. Config — `packages/assistant-contract/src/mcp-config.ts` owns the shared
   transport grammar, normalization, migration records, and machine-readable
   `invalid_mcp_config` diagnostics at the explicit `mcp-config` package
   subpath. Consumers add capability-scoped wrappers: Agent rejects bearer
   references because it has no production credential resolver, while Desktop
   accepts them and resolves credentials in its owning host. Agent JSON and
   Desktop JSONC ingestion both use the shared grammar; Desktop additionally
   retains syntax/location, duplicate-key, and established user-facing prose
   diagnostics and revalidates decrypted records. Unknown fields, malformed
   spawn/HTTP values, and unsupported policy combinations fail visibly.
   `{ servers: [] }` is accepted
   as an explicit request for no configured servers; it does not synthesize a
   server, and Agent without a host returns no runtime client. Public renderer
   status exposes server name, transport, effective protocol policy, and
   token-free migration records.
2. Official clients — `packages/agent/src/mcp/explicit-stdio-client.ts` and
   `explicit-http-client.ts`, exported only from
   `@brainstrike/agent/mcp-client`, own the stable SDK v2 split-package transports,
   lazy/concurrency-safe connection, request forwarding, and idempotent close.
   The HTTP client additionally owns header composition and Streamable HTTP
   session termination. Core resource/template/prompt/completion operations and
   modern `subscriptions/listen` remain on the same request/recovery seam as
   tools. The first cursorless tools/resources/templates/prompts list on every
   new HTTP or stdio connection forces the SDK cache to refresh; subsequent
   requests use the caller/SDK cache policy. Feature-event subscribers settle
   independently with `Promise.allSettled`, and each rejection reaches the
   explicit diagnostic sink even when another subscriber or the sink itself
   rejects. SDK client close remains the sole subscription/listener teardown
   owner. This transport support does not update the product support matrix;
   the desktop authority layer must integrate and verify it first.
   `client-extension-registry.ts` is the typed host-owned
   capability boundary; it does not implement an extension itself. Only
   non-empty MCP config loads the dedicated subpath; keep split SDK packages out
   of root/browser-safe/Hosted Web bundles (the emitted-bundle verifier enforces
   this). Cross-package Desktop integration tests use only the explicit
   `@brainstrike/agent/test-fixtures/mcp-host-lifecycle` and spawned-fixture
   exports. They never traverse Agent's private `src/__tests__` tree, and the
   fixture entrypoints remain unreachable from production Agent entrypoints.
3. Desktop host composition — `apps/desktop/src/mcp/host-runtime.ts` constructs
   the shared explicit clients only behind `McpHostService` actors. The dormant
   pre-host global client registry, desktop `McpClient` wrapper, and HTTP/stdio/SSE
   factory adapters do not exist. Shared token-free status projection and
   discovered-tool types remain in `apps/desktop/src/mcp/types.ts`; removing the
   obsolete wrappers must not remove those helpers or any protocol-era behavior
   owned by the active explicit clients.
4. Desktop authority — startup configuration and tool discovery flow through the
   singleton `DesktopMcpHostRuntime`; malformed reloads preserve the last valid
   authority, absent config installs explicit empty authority, and stale
   discovery epochs cannot overwrite a newer config projection. File-watcher
   projections are serialized, stale loads are discarded, and reload failures
   remain distinct from projection callback failures. Shutdown closes the active
   host and aggregates its close report; factory reset replaces its resolved
   configuration with explicit empty authority. Neither path invokes a parallel
   legacy registry cleanup owner.
5. Agent runtime — `packages/agent/src/mastra/mcp-runtime-client.ts` adapts the
   injected desktop host authority; it never constructs or closes an SDK client.
   Each run owns only generation-fenced watchers and cancellation leases, rolls
   them all back on partial construction failure, and applies the host snapshot's
   enabled-tool policy before converting discovered tools through the shared
   Mastra adapter. Progress and caller cancellation forward through the host.
   This preserves the
   complete `CallToolResult` until the adapter deliberately selects
   structured-only output or retains mixed structured+media output; upstream
   wrappers may not collapse either transport first. All tools then use the
   existing pipeline: discovery → namespace/sanitize → output bound → guard →
   hooks → permission. Remote progress uses the distinct transient
   `brainstrike.mcp-progress.chunk` `writer.custom` part and maps back to a
   `tool-event`; progress-channel failure is warning-only and never replaces a
   completed tool result or the remote tool's primary error.

Primary references:
- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://modelcontextprotocol.io/extensions/overview
- https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
- https://github.com/modelcontextprotocol/typescript-sdk/blob/%40modelcontextprotocol%2Fclient%402.0.0/docs/migration/upgrade-to-v2.md

When changing this flow, update this section and the focused agent + desktop
real-protocol integration tests.

### MCP verification harness and official conformance

The verification harness, the production official-conformance client entry,
the bounded official-runner driver, evidence schemas, and the durable official
conformance evidence links live in `docs/agents/mcp-conformance.md` (moved
there under BST-1590 to end doc contention on this file). This document keeps
only the provider-facing rules above: transport selection, protocol era, auth
policy, and the host runtime contract.

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
complete resolved transport configuration to opaque UUID refs, reusing a ref
only for deep-equal private configuration. Raw URLs, headers, commands, argv,
environment, and decrypted values remain behind that main-process map; failed
replacement never commits provisional refs. Legacy authorization headers remain
private transport material until the structured OAuth/credential migration.
The runtime snapshots caller-owned resolved configuration before assigning a
ref. Public `enabledTools` preferences do not participate in private ref
identity; server identity, protocol, transport, and connection material do.
Resolved-config and raw host replacements share one recoverable queue. During
an ordered replacement, actor creation resolves staged refs first and committed
refs second so an earlier self-heal cannot lose its still-current authority.
Rejected asynchronous diagnostic sinks are isolated and logged rather than
escaping as unhandled rejections.
Its default singleton connects the official explicit HTTP/stdio client before
publishing negotiated readiness. HTTP is always `host-owned`; successful actor
close reports one client and observer callback, one stdio child when applicable,
and the exact number of operations settled through that client wrapper.
Those counters mean known owned resources whose close promises proved terminal,
not guessed teardown actions: actor close first drains every accepted operation,
and explicit stdio close resolves only after its transport/client graph settles.
If connection or negotiation fails and cleanup also fails, both causes remain in
one aggregate diagnostic; no clean close proof is fabricated.

The surrounding host boundary has these additional invariants:

- Configured server ids are branded, limited to 128 Unicode code points, reject prototype-sensitive names plus Unicode control/format characters with specific diagnostics, and are never recovered from dotted tool or display names. Lifecycle and error vocabularies are closed.
- Browser-safe config carries only main-owned transport UUIDs, non-secret policy, and typed credential-store references. Decrypted material stays in Electron main; transport/protocol schemas track the shared unions, and SSE accepts only `legacy`.
- Operation results use nested `{ type, result }` envelopes. Electron main parses raw results through the browser-blocked `./mcp-host-runtime` subpath and the matching SDK-v2 schema, requiring strict JSON-safe open fields before IPC. The broad contract root retains only MCP SDK type imports.

Every actor validates negotiated status, operation results, and close reports
through the browser-blocked runtime parser before publishing or returning them.
`ExplicitHttpMcpClient` defaults to `client-owned` lifecycle so existing direct consumers retain one bounded
expired-session reconnect and request replay. Host composition must select `host-owned`: a session-invalidating 404 invalidates the connection, emits one unexpected-close signal, and returns the original failure without replay. Transport code never infers ownership.
`ExplicitStdioMcpClient` publishes pending child ownership before connection begins, sets terminal closure
synchronously before teardown, and reaps pending and active children through one idempotent close promise. Only an active connection emits the observer signal; pending failures reject connect directly. Observer exceptions are isolated, and the next operation creates a fresh child without replay.
Terminal closure also SETTLES THE CONNECTION'S IN-FLIGHT TRANSPORT WRITES
(`installMcpStdioSendClosure`, BST-1600). Node's parent-side pipe to a child
that has exited or closed its read end returns `false` from `write()` and never
emits `'drain'` again, and the SDK's `StdioClientTransport.send()` resolves only
on that `'drain'` — so a message written into a dead child's pipe returns a
promise that never settles. `Protocol.request()` survives that (its response
handler is settled by `_onclose`), but `Client.listen()` awaits the send BEFORE
it can handle its own `opening` promise: a child that dies in that window used to
hang `subscriptions/listen` and the whole connect sequence forever — orphaning
the client past main's 5s `SIGNAL_SHUTDOWN_TIMEOUT_MS` — while
`Client._onclose`'s `SdkError: Connection closed` escaped as an unhandled
rejection in Electron main. Closure now rejects those writes visibly, so the
failure classifies like any other. Never wrap this in a swallowing catch, and
never assume a stdio `send` promise settles on its own.
WHERE the closure fires is itself an invariant. `invalidateConnection` severs
first, before its `disconnected` short-circuit, because `client.onclose` fires
only from the child's process `close` event — the pipe really is gone by then.
`closeConnection` severs LAST, after its teardown `allSettled`: severing first
would poison the connection's own farewell traffic (the SDK answers a capability
request the lease aborts through the transport it captured at request time) and
would blame a dead pipe for a still-live child's ordinary backpressure. After
`transport.close()` the parent's write end is ended and the child killed, so the
severed-pipe cause reads accurately on every path. No teardown step awaits a
send, so the later sever cannot deadlock.
Actor state is single-writer and generation-bound. A failure remains the latest
snapshot through teardown; observer exceptions are isolated and diagnosed, not
allowed to corrupt invocation or cleanup. Because `change` is that unconditional
single writer, a successful client handshake never publishes `connected` once a
failure has been recorded: a stdio child that exits mid-handshake reaches
`onUnexpectedClose` before the client factory returns, and `createClient`
rethrows that failure instead of clobbering the row (BST-1600).
Public actor close is idempotent and
never rejects. Its report includes an explicit sanitized `failures` array in
addition to non-negative safe-integer resource counters, so a failed teardown
cannot masquerade as an all-zero clean proof. Client-reported failures are
replaced with actor-owned bounded errors before return; the raw report reaches
only the diagnostic sink. Every returned report and nested failure array is
frozen in the actor process. For an errored actor, the error remains the final
snapshot and the resolved close report is the sole teardown-completion proof;
there is deliberately no post-error `disconnected` event. Raw internal causes
reach one required main-process diagnostic sink; they may contain credentials
and must never cross renderer IPC or bypass the platform redaction path.

`McpHostPort` exposes exactly `snapshot`, `invoke`, `watch`, `replaceConfig`,
`control`, and `close`:

- `snapshot` returns token-free authority state, negotiated protocol revision,
  server identity, capabilities, auth/lifecycle status, and bounded diagnostics.
- `invoke` accepts a closed typed operation union. There is no raw
  `request(method, params)` escape hatch and no method-per-SDK-verb public API.
- `watch` is filtered and token-free. Subscribers cannot obtain the host, SDK
  values, credential handles, or another server's private events.
- `replaceConfig` is ordered with invocation and lifecycle work. It advances the
  server generation, rejects new work against the retired generation, settles
  or cancels owned work explicitly, and closes old transports before publishing
  the replacement as ready. It never mutates a live client in place.
  Caller cancellation stays distinct from `mcp_generation_retired`; unexpected closure replaces only that server without replay.
- `control` accepts only the closed `connect` / `retry` / `cancel` / `disconnect` /
  `reauthorize` action union. It is the sole way to begin user-paced
  authentication, retry a failed generation, cancel one, or clear and replace
  one selected OAuth authority; each action returns the resulting token-free
  server snapshot and retains failed servers even when discovery found zero
  tools; cancel stays actionable during connect and bypasses that operation's config barrier.
- `close` is terminal and proves that every owned client, request, subscription,
  callback listener, loopback port, probe, and child process is gone.

BST-1471 extends that closed `invoke` union with resources, resource templates,
prompts, completions, and resource subscription control. Each connected actor
owns one per-server catalog with independent section errors; list changes
refresh only that actor's affected entries. Modern connections register change
handlers once and open `subscriptions/listen` with the advertised-capability
intersection, retaining the honored filter and re-listening with a three-attempt
bounded backoff only after remote closure. Legacy connections never send
`subscriptions/listen`; they retain unsolicited list changes and explicit
`resources/subscribe` / `resources/unsubscribe`. SDK `ttlMs` and `cacheScope`
remain authoritative, with private cache entries partitioned by the connection
generation. Settings may browse catalog metadata and errors, but resource and
prompt bodies are never eager model context: only explicit user browsing or a
typed authorized host operation reads them.

BST-1578 adds `@brainstrike/assistant-service/mcp-content-application-port`, a browser-safe seam
limited to `resources/read`, `prompts/get`, and `completion/complete` for one authorized server
generation. Inputs must fit 256 KiB before invocation. One filtered watch and cancellation lease
check authority around registration and invocation; the generation must be connected and advertise
the catalog feature. Capability/state, cancellation, retirement, snapshot, watch, unknown invoke,
and result-validation failures retain public or diagnostic taxonomy. The required internal-error
sink receives raw causes on the trusted redaction path; public errors remain fixed, cause-free, and
safe. Schema-validated, operation-matched results are limited to 4 MiB serialized UTF-8 and reject
overflow. The seam exposes no raw `invoke`, SDK client, renderer IPC/UI/persistence, subscription,
or automatic model-context injection.

BST-1585 gives each of those three verbs one production caller: user-initiated catalog browsing in
Settings (`packages/settings-ui/src/settings/tools/mcp-support-status.tsx`). `Read` on a listed
resource issues `resources/read`; `Use prompt` opens an inline argument form whose inputs call
`completion/complete` (`ref/prompt`) for suggestions and whose submit issues `prompts/get`.
Completion is gated on the server's advertised `features.completion`, debounced (250 ms), skips
empty input, and dedupes values. Bodies render bounded (text truncated at 2 KiB, at most 20
contents, messages, or suggestion values per view, blobs and non-text content shown as metadata
only) and are never eager model context; the catalog remounts per server generation so a retired
generation's content or draft never carries over. Desktop main
owns one `createMcpContentApplicationPort` per host runtime (`apps/desktop/src/mcp/content-port.ts`,
memoized so factory reset keeps the singleton) with the main-process logger as the required
internal-error sink. The `mcp:content:readResource` / `mcp:content:getPrompt` /
`mcp:content:complete` channels (`apps/desktop/src/mcp/content-ipc.ts`) each force their own verb
server-side, validate the renderer payload strictly, wait on the MCP lifecycle barrier and reject
while admission is closed, but never enter the non-reentrant config-operation queue. They carry the
same fail-closed `visible-ui` sender policy as secrets (hidden inference hosts and untracked senders
are rejected before any payload is parsed). Failures travel as a result envelope
(`{ ok: false, error: { category, code, message } }`) rather than a thrown Error, because
`ipcMain.handle` replies to a throw with Electron's formatted string, main-process stack included;
the preload unwraps the envelope into a clean Error whose message is `message (category · code)`.
Only that fixed taxonomy crosses IPC: `hostError` text is server-originated and stays in main. The
renderer never sees `invoke`: the preload bridge exposes exactly `readResource`, `getPrompt`, and `complete`, and
settings-ui receives them as optional `readMcpResource` / `getMcpPrompt` / `completeMcpContent`
operations gated on bridge presence, so web omits the affordance entirely. Pinned by
`apps/desktop/src/__tests__/main/ipc-mcp-content.test.ts`,
`apps/desktop/src/__tests__/preload-runtime-contract.test.ts`,
`apps/desktop/src/__tests__/renderer/components/settings/page-content-operations.test.tsx`, and
`packages/settings-ui/src/settings/tools/__tests__/unified-tools-settings.test.tsx`.

BST-1592 makes prompts selectable from the COMPOSER, so using a prompt no longer requires opening
Settings. MCP prompts are a FOURTH entry kind in the same `SlashCommand[]` the app commands,
user-defined `/commands`, and Agent Skills already flow through
(`packages/app-shell/src/use-mcp-prompt-slash-commands.ts`, merged last by
`useAssistantSlashCommands`) — there is no parallel autocomplete surface. The list is a pure
projection of the revisioned host snapshot (`mcp-prompts/mcp-prompt-catalog.ts`): only a CONNECTED
server that advertises `features.prompts` and listed the prompt is offered, ordered by configured
server id then prompt name. Two servers may expose the same prompt name, so both the command id
(`mcp:<configuredServerId>:<promptName>`) and the menu label (`<title> · <configuredServerId>`)
carry the configured server id — with `:` and `\` ESCAPED in both components, because a
configured server id and a server-authored prompt name may each contain the delimiter and plain
concatenation is then not injective (server `a` + prompt `b:c` and server `a:b` + prompt `c` both
produce `mcp:a:b:c`, and the duplicate-drop would discard one valid prompt). Every ordinary id is
byte-identical after escaping and the LABEL keeps the raw values. The two snapshot channels (the
initial `getServerStatusSnapshot()` read and the pushed `onServerStatusUpdated` events) are ordered
by `McpHostSnapshot.revision`, not just by the effect generation: a late-resolving older snapshot is
DROPPED, so a slow initial read can never restore a list a newer push already replaced.

Desktop-only by construction: `resolveMcpPromptBridge()` requires all four `window.mcp` members
(`complete`, `getPrompt`, `getServerStatusSnapshot`, `onServerStatusUpdated`) and returns a
three-state resolution. `unsupported` (no `window.mcp`, or a host exposing NONE of the content
members) is a legitimately absent capability and stays quiet — that is web. `malformed` (SOME but
not all members) is a preload/packaging defect: `McpPromptComposerHost`, which is always mounted,
names the missing members in a destructive toast, so the capability can never vanish into something
indistinguishable from web. The two states never share a code path.

Selecting a prompt performs NO request. `execute` captures the live draft split around the typed
trigger (the adapter strips it afterwards, and the popover can be invoked mid-draft, so trailing
text must survive) and hands the selection to the app-wide `McpPromptComposerHost`
(`packages/app-shell/src/mcp-prompts/mcp-prompt-host.tsx`, mounted beside `McpElicitationHost` in
`root-layout-content.tsx`). That host owns every effect: an argument-less prompt stages immediately;
an argument-taking prompt opens `McpPromptDialog`, whose inputs call `completion/complete`
(`ref/prompt`, 250 ms debounce, empty input skipped, values deduped and capped at 20) and whose
submit issues `prompts/get`. The pinned generation is watched for the lifetime of the selection, so
a server that disconnects mid-selection blocks submission with a visible message instead of
retargeting another generation — the visible half of a failure the content port would reject anyway.
The result lands in the composer DRAFT via `assistant-composer-command-store`, never auto-sent and
never eager model context: the same contract as user-defined `/commands` and Agent Skills. Two
things are re-checked AFTER the `prompts/get` await, because the composer stays live across it.
First, the pending selection: the dialog is deliberately still dismissible mid-request (Escape and
outside click reach `onOpenChange`; a modal that cannot be closed is worse UX than one that can), so
`stage()` re-reads the selection store and discards a result whose selection was dismissed or
replaced — the abort is honoured where the write happens, not by disabling the escape hatch. Second,
the draft: `mode: 'replace'` uses the SELECTION-time split only while the live draft is still the one
that split was computed against — either the draft as it stood when the prompt was picked, or the
draft the popover leaves after its own `setText(before + (after.startsWith(' ') ? after.slice(1) :
after))` strip. Once the user has typed (or sent and started a fresh draft) the prompt is APPENDED to
the live draft instead, so a slow prompt can never silently overwrite what they wrote.

The typed trigger is located as the LAST whitespace-delimited `/token` in the draft, not as a
`/mcp:`-prefixed one: the pinned adapter's `matchesQuery` is a SUBSTRING test over id, label, and
description, so `/echo` legitimately selects `mcp:legacy:echo_reference`, and a `/mcp:`-anchored
match left that token in the staged draft. The leading-boundary group keeps a URL path from being
mistaken for a trigger, and scanning all matches (rather than a `(?!.*…)` lookahead, whose `.` never
matches `\n`) makes the "last trigger wins" rule hold across LINES.

A single user text message stages verbatim; anything else is role-labelled, and
image/audio/resource parts are REPORTED in a toast rather than dropped, with a prompt carrying no
text at all failing visibly.

`completion/complete` with `ref/resource` has NO product caller and stays HOST-ONLY: it exists on the
typed `invoke` union and the content port for a future resource-TEMPLATE surface, and resource
contents entering assistant context remains out of scope until a bounded-context design exists. Do
not add a caller for it as a side effect of another ticket. Every content VERB
(`resources/read`, `prompts/get`, `completion/complete`) now has a product caller.

The packaged proof runs in `apps/desktop/e2e/mcp-packaged-core.desktop.test.ts` against the
Brainstrike-owned echo reference fixture (the `legacy` server), NOT the pinned official everything
profile: Settings `Read` on the echo resource proves `resources/read` reaches the renderer, and the
composer "/" menu → argument dialog → `Insert prompt` proves `prompts/get` does, with the server's
own message text asserted in the composer draft. The fixture gained that content in
`packages/mcp-test-lab/src/reference-server.ts` (`ECHO_REFERENCE_CONTENT`); its `completions`
capability comes from a `completable()` prompt argument, which also installs the SDK's own
`completion/complete` dispatcher — a hand-written handler for that method would collide with it.
Pinned by `packages/app-shell/src/__tests__/mcp-prompt-catalog.test.ts`, `mcp-prompt-text.test.ts`,
`use-mcp-prompt-slash-commands.test.tsx`, `mcp-prompt-host.test.tsx`, and
`packages/mcp-test-lab/__tests__/lab-http.integration.test.ts`.

Every promise-returning host operation reports malformed input and terminal
closure as a rejected promise; `McpHostService` owns the typed `mcp-host-closed`
error rather than leaking a publisher collaborator's error type. Terminal close
invalidates watch registrations synchronously, includes their exact count in the
frozen close proof, and suppresses actor state callbacks after closure begins so
normal teardown cannot create false listener-failure diagnostics.

A retirement close report containing failures still removes that actor from
routing and reconciles the publisher to the retained actor set before
`replaceConfig` rejects. The exact frozen aggregate then latches the host:
every later replacement rejects with the same proof, including configurations
unrelated to the failed server, while retained actors remain invokable. The
only recovery is terminally closing and reconstructing `McpHostService`; there
is no retry or reset that could silently claim failed cleanup succeeded.
Successfully retired actor/client graphs are released after their detached
close reports are folded into one lifetime ledger aggregate. Terminal `close` aggregates that ledger
with all actors current at shutdown, so its one frozen report proves cleanup
across the complete host lifetime without retaining closed transports.

A config publication failure closes every provisional actor and records their
detached reports before it attempts to republish the retained authority. Failed
provisional cleanup latches its frozen close proof before reconciliation starts;
if retained-authority reconciliation itself fails after otherwise clean cleanup,
the host latches a frozen `mcp-host-publish-failed` proof. The original operation
still rejects visibly, and every later replacement rejects with the latched proof
until terminal close and host reconstruction. No unpublished actor remains owned
or routable, and no later replacement can bypass a cleanup or reconciliation
failure.

Retained actor snapshots are re-read after every awaited retirement or
provisional cleanup before authority is reconciled, so a legitimate transition
during teardown cannot be overwritten by a stale higher revision. Actor
transitions emitted before publication or after retirement are ignored for
authority but reported through the required diagnostic sink; they are never
silently dropped.

The host publisher alone owns a monotonic revision sequence beginning at zero.
Config and actor publications advance it only for a material state change.
The queued event and returned snapshot are separate detached values. Filtered watches receive only
events affecting one of their configured server ids and may therefore observe
revision holes. Empty configured-server-id filters are rejected visibly rather
than registered as silent no-op subscriptions; non-empty filters may name a
future configured server so callers can subscribe before configuration lands.
Actor transitions must exactly match the config-owned generation, protocol policy, and transport.
Lower and higher generations, policy mutation, and transitions from a server
removed by configuration throw typed attributable errors; they never regress,
advance, or resurrect authority state.
Listener failures are isolated and reported through bounded diagnostics.
Terminal host close invalidates queued and future watch registrations because
the closed watch DTO has no terminal event variant; a future terminal event
requires an explicit contract/schema revision rather than an invented payload.

Desktop lifecycle composition lives in `ipc-mcp.ts`. Shutdown first stops and
drains the assistant HTTP server, then closes MCP configuration admission,
stops the file watcher, awaits every tracked load/replacement/discovery, clears
the renderer projection, and terminally closes the singleton host. Process,
terminal, command-session, and LSP
reapers start in the same settlement batch as assistant-server stop, so a hung
or rejected drain cannot prevent those attempts. A rejected drain is recorded
as an ordering failure, but terminal MCP cleanup is still attempted. Host
close-report failures remain visible in the shutdown `AggregateError`; a
zero-failure host proof therefore covers its
clients, accepted requests, subscriptions, callbacks, loopback ports, probes,
and stdio children; shutdown/reset log this at INFO, including empty reset authority. Factory reset uses the
same lifecycle fence but does not close the singleton: after prior config work
settles it installs explicit empty authority, purges projections, and keeps
admission closed through the enclosing database/user-data
purge and visible-renderer replacement. Main waits for the replacement React
tree's explicit renderer-ready ping before it restores the permanent watcher
and reopens empty authority; load completion alone is insufficient. A failed
purge instead restores the captured pre-reset authority and projections before
admission reopens. Every config IPC
operation joins the lifecycle barrier before its first asynchronous side
effect. Work admitted before the fence therefore cannot publish after cleanup,
and a watcher created across the fence is closed immediately. The tracked
operation queue is deliberately non-reentrant: code already inside it must use
the `*ForLifecycle` helpers with the captured epoch. File-watcher callbacks use
the lifecycle barrier and generation checks but deliberately stay outside the
serialized IPC queue. The native config picker is also outside that queue and
barrier because it is user-paced; only its final selected-path grant is
epoch-guarded. Config unwatch remains teardown-safe after admission closes.
Tool mutations capture the registry authority epoch at invocation and reject
visibly if a queued config reload rebuilt the registry before they execute.

Assistant adapters may discover and invoke but cannot mutate auth or
configuration. Renderer IPC receives only snapshots and explicit Settings
actions such as Authenticate, Reauthorize, Disconnect, Retry, and Replace
Configuration. Opaque server, invocation, continuation, task, and Apps ids are
never reconstructed from display names.

The startup policy prevents unsolicited interactive OAuth. Native
HTTP `oauth-user` entries that omit startup normalize to
`authentication-required`; explicitly selecting `automatic` is invalid. An
`npx -y mcp-remote ...` shape is normalized to `authentication-required`, even
when the legacy config omitted startup policy. Native HTTP OAuth with stored
credentials reconnects during app-load discovery; missing or unreadable
credentials still wait for explicit Connect. The actor passes a separate
interactive-authorization flag to each connection attempt. Automatic attempts
may reuse/refresh credentials, but the provider rejects browser authorization
before arming a callback or calling openExternal. Config loading and startup
discovery therefore cannot spawn a browser. Stdio OAuth helpers keep the
explicit-connect policy because Brainstrike does not own their credential or
browser flow. Restart and refresh behavior is covered through the production
host plus app-load discovery in `mcp-oauth-client-provider.integration.test.ts`;
missing credentials, login-required recovery, and the bounded first request
are covered by `mcp-host-runtime-oauth.test.ts`.
Connect, Cancel, Disconnect, Reauthorize, and
Retry are capability-gated Settings actions. Cancel is dispatched directly to the owning actor,
aborts the active connect signal, and settles child/listener cleanup without
waiting behind config replacement or discovery work. User-paced stdio auth
omits Brainstrike's absolute request budget and uses the Node platform-maximum
numeric timer (`2^31 - 1` ms) required by the SDK 2.0.0 public request API;
this is an SDK constraint, not a product auth deadline, and cancellation is
still signal-driven. Ordinary post-connect requests retain the normal bounded
request policy. Discovery starts all actionable servers concurrently, while
status snapshots retain every zero-tool, authentication-required, and failed
server plus bounded, redacted stderr diagnostics.

Production migrates atomically to `@modelcontextprotocol/client@2.0.0`; v1 and
v2 class instances never cross the host boundary. The release tag used by this
contract peels to `cc4b41617ce3601b1290d67216ea0b194a3cd9ac`, and modern
negotiation targets MCP `2026-07-28` while retaining explicit legacy policy.
Post-release SDK behavior requires an explicit dependency update and its own
regression proof; a transitive package or later upstream `main` is not evidence.

Remote OAuth is owned entirely by Electron main through the SDK OAuth provider
and a dedicated encrypted MCP credential store. The store is separate from
model-provider credentials and partitions records by configured server,
authorization issuer, protected-resource URI, client identity, and granted
scope set. Browser redirects, PKCE verifiers, authorization codes, access and
refresh tokens, and client secrets never cross preload or renderer IPC.
Disconnect, config removal, revocation, and factory reset clear both encrypted
records and in-memory refresh/session state; a storage failure is visible and
never converted into an unauthenticated fallback.

Explicit Connect cancellation spans the entire control request, including a
background-to-interactive handoff, rather than borrowing the first transport
attempt's signal. Cancel aborts that request even if the new factory has not
settled; late factories are still drained and closed by the actor.
`mcp-server-actor.test.ts` pins this cancellation boundary.

The host republishes `provider.authSnapshot()` after connection settlement,
including failure after SDK credential invalidation, so Settings does not retain
"stored" after an `invalid_grant` removes the tokens. The host OAuth regression
pins missing credentials and cleared granted scopes before explicit retry.
Auth publication is owned by the latest connection attempt and is invalidated
by explicit credential clearing. A cancelled attempt that finishes cleanup late
cannot overwrite a replacement provider's credential facts; the host regression
holds old cleanup open across Cancel and successful Connect to prove this.

Production host composition creates the OAuth provider for stored-grant
background discovery and explicit Connect or Reauthorize actions. Only an
explicit true authorization option permits browser consent; omission is
non-interactive. It passes both `provider.fetch` and `authProvider`
to `ExplicitHttpMcpClient`, and for OAuth-user Streamable HTTP also passes the
provider's one-shot `takePendingAuthorizationCallback(signal)` source. The
agent client alone consumes that source, calls the SDK transport's `finishAuth`,
and retries the opening connection or challenged request. No callback params
leave Electron main, and absence of a pending callback returns `undefined`
instead of guessing that an authorization retry exists. The callback source
consumes each pending flow once and follows caller cancellation; the owning
actor closes the provider callback/listener on cancellation, disconnect,
replacement, failed connection, and terminal close. Ordinary close and app
restart preserve encrypted credentials. Disconnect and Reauthorize close the
selected actor first, then
clear only its canonical configured-server/protected-resource identity;
Reauthorize alone immediately begins a fresh explicit connect. The browser-safe
snapshot exposes only the protected resource, authorization-server identity,
requested/granted scope names, credential presence or an explicit unreadable
state, and the last successful connection time—never tokens, authorization
codes, verifiers, client secrets, or credential-store keys. OAuth records are
partitioned by configured server, canonical resource URL, and requested scope
set; a URL or scope change cannot silently reuse the previous grant. Provider
close returns explicit callback/listener proof so host close accounting is
derived from owned resources rather than fixed assumptions.

Linear's native configuration uses Streamable HTTP at
`https://mcp.linear.app/mcp` with `auth.type: "oauth-user"`; Brainstrike does not
wrap it in `mcp-remote`. That endpoint is read-write by default. Hard read-only
uses `https://mcp.linear.app/mcp/readonly`; alternatively the standard `/mcp`
resource with only the `read` OAuth scope produces a read-only token. Each
workspace/resource must use a distinct configured server identity so its OAuth
records and destructive controls remain isolated.

BST-1468 supplies the main-process provider seam in
`apps/desktop/src/mcp/oauth-client-provider.ts`. It deliberately delegates
the protocol algorithms to the installed `@modelcontextprotocol/client@2.0.0`
implementation: RFC 9728/RFC 8414/OIDC discovery, RFC 9207 issuer checks,
CIMD/pre-registration/DCR selection, PKCE, RFC 8707 resource binding, refresh,
one 401 retry, and 403 insufficient-scope step-up. The provider supplies an
stable `127.0.0.1` callback listener, the validated external-browser handoff,
encrypted state persistence, and a generation-tagged refresh fetch seam. The
provider fetch must be passed to the SDK transport for refresh coalescing and
disconnect fencing to apply. The later UX ticket owns the explicit
Authenticate/Reauthorize action and the startup `authentication_required`
projection; no background connection may open a browser implicitly.

**Stable loopback port (BST-1597, do not relitigate).** The dynamic client
registration records `redirect_uris: [http://127.0.0.1:<port>/mcp/oauth/callback]`,
and `persistedClientSupportsRedirect` compares that URI by exact href. An
ephemeral port therefore invalidated the registration on **every** relaunch, for
**every** DCR server, which then burned the authorization allowance and reported
`mcp-connection-failed` beside stored credentials. The bound port is persisted
per store identity (configured server + canonical resource + requested scope
set) as `loopbackPort` on that identity's records, and the next launch rebinds
it before the provider is constructed — so `loadOAuthStartupState` reads the
store BEFORE it listens, never concurrently. Per-identity rather than one
app-wide port because several OAuth servers can be connected at once and each
needs its own live listener; the port lives with the registration it belongs to,
inside the same encrypted store, so disconnect and factory reset already clear
it and no new persistence surface exists. The loopback comparison is
deliberately NOT relaxed for a differing port: RFC 8252 §7.3 is a SHOULD on the
authorization server, and trading a deterministic re-registration for an
`invalid_redirect_uri` the code cannot recover from would be a silent
degradation. A port another process now owns falls back to a fresh one, reports
`reportUnavailableLoopbackPort`, and accepts that a re-registration follows.
The bind-time `'error'` rejector is removed once the listener binds, so a
permanent replacement handler takes its place: a bound `http.Server` with no
`'error'` listener turns a later accept-path fault (EMFILE/ENFILE) into an
unhandled `'error'` event, which in Electron main is a process crash rather than
a failed OAuth callback. The fault is reported through
`reportLoopbackListenerFault`, never absorbed silently and never rethrown.

Discarding a registration means the stored grant is unusable, so the provider
raises `requiresReauthorization()` and `closeAfterConnectFailure` reclassifies
the connect fault as `mcp-authentication-required` — the actor's
`authentication-required` state with a Connect affordance — instead of a
terminal connection failure. That rewrite is deliberately narrow: ONLY the
generic `mcp-connection-failed` fallback is rewritten, because
`mcp-browser-open-failed`, `mcp-auth-callback-timeout`, `mcp-server-rejected`,
`mcp-protocol-timeout` and `mcp-child-exited` already name an actionable fault
and a second Connect button in their place hides the only thing the user can act
on. The latch itself is deliberately NOT cleared when `saveClientInformation`
writes the replacement registration: a registration whose authorization never
completed still leaves the stored grant unusable, which is exactly the relaunch
case the integration proof pins. It cannot strand a later unrelated fault
either, because the provider is constructed inside the per-attempt client
factory and closed with the attempt that failed — the next connect builds a
fresh provider that re-reads the store, finds a redirect-compatible
registration, and never raises the latch at all. Both reasons are logged, never
absorbed. Every provider start logs
`MCP OAuth loopback callback listener bound` with its port and
`reusedPersistedPort`; the packaged relaunch proof in
`apps/desktop/e2e/mcp-packaged-core.desktop.test.ts` asserts the restarted
launch rebinds the same port in the records IT appended, reconnects, and emits
no `Discarding stale MCP OAuth dynamic client registration` record.

The `2026-07-28` authorization-server migration contract requires a challenged
bearer request to rediscover protected-resource metadata before selecting the next
authorization server. A context-free token read marks that issuer's discovery stale;
reads and unrelated saves neither consume nor clear it. Only successful replacement
token persistence for that issuer clears the mark (close/reset clears all), forcing
fresh PRM while remaining bounded by persisted issuer records. Callback-leg discovery
remains available for RFC 9207 `iss` validation. Client information, tokens, and discovery
remain issuer-partitioned, so migration re-registers instead of replaying credentials.

Deterministic production-provider coverage lives in
`apps/desktop/src/__tests__/main/mcp-oauth-client-provider.integration.test.ts`.
It observes resource mismatch before DCR/authorization, `offline_access` inclusion
only when AS metadata supports it, the required RFC 9207 response matrix,
metadata-issuer rejection before endpoint use, and a real two-AS migration with
replacement registration and no original-AS credential reuse. The alpha.10
closeout remains the final 11/11 fixture proof; an always-connected host mock is
not security evidence.

Canonical basis: the [MCP 2026-07-28 authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
requires strict authorization-response issuer validation and issuer-bound client
credentials; RFC 9207 requires validation before code redemption; RFC 8707 and RFC
9728 define resource binding and protected-resource metadata. The installed
alpha.10 package resolves to npm `gitHead`
`a9896553900a2ef61787b57adfcbbe936a8ab1f9`; its CLI is the applicability authority,
not later upstream `main`.

The package exports `./faults` only after every fault variant, declaration key,
match key, occurrence, reachability rule, and coordinate shape is validated.
Fault plans are closed declarative data created only by
`createMcpLabFaultPlan`; structural substitutes are rejected. The factory
bounds and snapshots declaration arrays with indexed reads, validates
diagnostic-safe ids and exact coordinates, freezes factory-branded plans, and
snapshots each consumption before lookup. Occurrences must be reachable, and
fault kinds are bound to compatible coordinates.

The era method sets match the released `@modelcontextprotocol/core@2.0.0`
codec registry at `cc4b416`. Authentication, era, transport, fixture, and
execution discriminators are closed. `assertScenarioFaultCompatibility` is the
single mapping from a canonical scenario plus execution topology to those
validators; callers never translate `streamable-http` into a lab transport.

HTTP fault execution is private package machinery; the executor, qualifier,
correlation registry, OAuth hooks, and dropped-response sentinel are not public
exports. A scenario snapshots and compatibility-checks its branded plan before
atomically claiming it and before allocating a handler, listener, OAuth record,
or child. Only the private claimed capability may consume faults. A claim is
single-session and permanent even when later startup fails; a plan consumed
through its public test API, attached twice serially or concurrently, or mutated
publicly after claim fails visibly before another allocation. HTTP in-process,
loopback, OAuth, and stdio sessions all execute `shutdown/transport/close` delay
and cleanup-error faults. Stdio also executes `child/spawn` delay and real
`child/stderr` after spawn and `child/exit` only after the official server has
answered the handshake and a post-handshake send occurs. Syntax-invalid child
stdout is not executable: the pinned reader skips it invisibly. Modern
stdio delay and response-drop execution covers `server/discover`, `tools/list`,
`tools/call`, and `subscriptions/listen`; cancellation and progress notifications
accept delay only. Server-to-client, wrong-era, and fixture-unreachable
coordinates fail at startup.

The stdio owner peeks at child configuration without consuming it, then commits
stderr and exit faults only after the corresponding control write or signal
succeeds. Spawn failure therefore leaves stderr and exit untriggered. Injected
stderr is emitted by the real child but diagnostics retain only a bounded byte
aggregate. Exit-code control uses a private per-session mode-0600 temporary
channel; signal exits target the captured PID only while the SDK delegate still
owns it. Close tears down the delegate before joining blocked sends, waits only
while that authoritative handle remains live, and removes the control directory
only after child ownership is released; the verifier proves the captured PID
reaches `ESRCH`. Diagnostics and reports never retain injected
stderr, environment, argv, or control content.

Stdio protocol sends are serialized in invocation order and qualified with the
pinned SDK client schemas plus its era classifier. Response-shaped, batch,
structurally invalid, wrong-era, and unsupported messages still reach the
delegate but never advance occurrences. A delay precedes the matching delegate
send; the runtime commits it only after that send succeeds. Response drop is
also committed only after successful send and suppresses exactly one matching
typed response id, distinguishing numeric `1` from string `"1"`. The official
client then owns bounded timeout/cancellation, and the next request remains
healthy. Close rejects new sends, aborts blocked delegate writes, closes the
delegate, drains the protocol tail, clears pending dropped ids, and only then
tears down child-fault state.

One private cleanup owner serially closes every session resource. An injected
cleanup error occurs before any resource is touched. A failed or partial attempt
retains unresolved ownership, concurrent callers share that attempt, and retry
skips resources already closed. Only complete success freezes the final report;
later close calls return that same deeply frozen report object. Reports contain
only aggregate listener/transport counts, frozen OAuth record counts, and safe
untriggered fault ids—never raw resource errors or injected content.

An MCP request can advance an HTTP or protocol occurrence only after one
serialized ingress qualifier proves the exact advertised `/mcp` URL with no
query, POST, JSON content type, a singleton SDK `ClientRequest` or
`ClientNotification`, the scenario era, the 2026 envelope when modern, and
standard header/body agreement. The qualifier uses the pinned SDK's
`classifyInboundRequest` and `specTypeSchemas`; it does not maintain a second
direction or envelope parser. Modern JSON-RPC requests require `Mcp-Method`;
notifications may omit it but must agree when present, and `tools/call` also
requires decoded `Mcp-Name` agreement. Bodyless, malformed,
batch, posted-response, wrong-route, wrong-verb, wrong-direction, unsupported,
and header-disagreeing traffic reaches the ordinary SDK rejection path without
consuming a fault. The parsed clone is passed to the SDK handler so an eligible
request is parsed once, and qualification stops cloning when no relevant fault
remains.

Non-OAuth loopback order is host/origin and advertised-authority validation,
qualification and unique correlation reservation, `node/dispatch`,
`http/request`, protocol injection, the real handler, then `http/response`.
OAuth loopback uses the same outer transport stages, routes authorization faults
through the validated OAuth endpoints, and defers MCP protocol injection until
after bearer authentication. Occurrences are independent per exact
phase/method. Ingress-stage coordinates are assigned in ingress order;
`http/response` is assigned in response-completion order. Caller correlations
must satisfy the bounded safe predicate and cannot repeat while the plan remains
active; generated correlations are deterministic and session-unique. Delay is
the only non-terminal HTTP fault. Status, malformed JSON, and drop stop later
coordinates; response-stage replacements cancel the displaced body before
returning or throwing.

OAuth authorization faults run inside route-owned hooks after complete route,
body, client, redirect, resource, state, PKCE, and capacity validation but
before client/code/token mutation. MCP operation faults run only after bearer
authentication and bounded body preparation. Thus a valid unauthenticated MCP
request may consume an outer transport fault but never an operation fault.
In-process drop rejects `endpoint.fetch`; loopback drop destroys the socket
before status bytes are written and leaves the listener usable. Handler
diagnostics are capped at 64 per session and contain only a safe correlation,
fault id, and fixed message. Session close waits for active fault delays before
closing owned handlers and listeners; its report exposes the closed-listener
count, sanitized OAuth record counts, and every untriggered fault id.

---


## ASSISTANT SEARCH TOOLS

The assistant's search verbs, in the order the default instructions present them:
1. `brainstrike.grepSearch` — FIRST for exact strings, identifiers, error messages. Two-phase: trigram-indexed ILIKE/regex-literal prefilter (`FileChunkRepository.findGrepCandidates`) + authoritative JS line matcher (`GrepSearchService` in packages/db/src/search/). Regex patterns with no extractable ≥3-char literal fall back to a bounded unfiltered scan; `scanLimited` reports true only when that scan hit its candidate cap (under the cap the scan was exhaustive — BST-951 ruled that over-reporting is as wrong as silence). The tool's hint builders MUST emit guidance whenever any of `truncated`/`scanLimited`/`candidatesTruncated` is set — the model projection enforces this and fails the run on a limited result without a hint. Truncation semantics are IDENTICAL in both output modes: `truncated` = items dropped by paging/budget OR either pass hit its own cap (index match cap, live candidate/walk/prefilter caps — live-capped matches are unreached on disk and never counted in `totalMatches`, so pagination alone cannot detect them). Desktop-only wiring in apps/desktop/src/assistant-server/grep-search-tool.ts. Progressive disclosure: default `outputMode: 'files'` returns per-path match counts (cheap survey); `outputMode: 'content'` returns line matches with context; both support `offset` paging.

    On a genuine zero-match result, `grep-zero-match-probes.ts` runs up to three bounded count-only probes in order: case-insensitive when the call was case-sensitive, literal when it was regex, then excluded/ignored paths unconditionally. The first hit becomes `probeNote` and renders as an additional `note:` line; all-miss is silent. Probe failure or timeout logs a warning and never fails the tool, while `live-grep.ts` owns the ripgrep-only `probeExcludedPathMatches` implementation; the excluded-path arm points at `globWorkspace(includeIgnored:true)` + `readWorkspaceFile` since `filePaths` cannot re-admit an excluded file. The probe's 1.5s rg budget over policy-EXCLUDED trees is a bounded best-effort by design: a timeout logs at debug (expected outcome), only non-timeout failures warn (BST-1246).

    **Live-pass ripgrep health (BST-1246).** The rg execution layer lives in `apps/desktop/src/assistant-server/live-grep-ripgrep.ts` (split out of `live-grep.ts`, which re-exports it — both files sit at the 1000-line lint ceiling). The live rg prefilter prunes EVERY directory the balanced policy hard-excludes by name (`BALANCED_UNCONDITIONAL_EXCLUDED_DIRECTORY_SEGMENTS` from `@brainstrike/utils` — not just `.git`/`node_modules`) plus every shared nested-path prefix (`.claude/worktrees` and `.brainstrike/worktrees`); pruning only two segments let artifact trees (`.vite` sourcemaps, `dist`, `.turbo`, `coverage`) blow the 4s rg timeout on real repos, silently degrading ~80% of grep calls to the capped JS walk in the 2026-08 audit. `resolveCandidate` re-applies the same policy, so the rg candidate set stays a strict SUPERSET of policy-kept files. rg exit code 2 WITH usable stdout (per-file read errors: permission denied, sockets under `--no-ignore --hidden`) keeps its candidates and surfaces `partialReadErrors` in the live note instead of discarding a good candidate set; exit 2 with empty stdout still falls back to the walk. Failures reject with `RipgrepRunError` — a pattern-free message plus non-sensitive metadata (elapsedMs, exitCode, killed, signal, timedOut) that the warn sites log alongside the redacted error, so the failure class is observable from diagnostics (full redaction previously made timeout indistinguishable from crash); `timedOut` is derived from the SIGTERM kill signal plus elapsed-vs-budget, never from `killed` alone, so an external kill stays a visible failure. The excluded-path probe deliberately searches UNPRUNED trees under a short budget, so its timeout is an expected bounded outcome: it surfaces as `timedOut` on the probe result and renders as "probe did not finish" in the zero-match note rather than a silent zero. All pinned in `live-grep-ripgrep-failure.integration.test.ts` ("runLiveGrep — BST-1246 ripgrep failure handling").

    **`filePaths` scope contract (BST-764).** One resolver — `apps/desktop/src/assistant-server/grep-file-paths.ts` — interprets the allowlist, and BOTH passes consume its output. Do not normalize paths in `live-grep.ts` or in the tool; a second, different transform is exactly how the two passes diverged (`runLiveGrep` used to do `p.replace(/^\/+/, '')`, turning an absolute path into a never-matching relative one and reporting a clean zero-match for a file that plainly matched). Rules:

    - **Workspace-relative** entries pass through normalized (`./`, `//`, and inner `.` segments collapsed) and pin no root.
    - **Absolute** entries inside exactly one open folder resolve to root-relative AND carry that folder's `rootId`. The tool passes those ids as `rootIds` to the indexed pass and narrows the live roots to the same set — without that, `/work/A/proof.html` flattened to `proof.html` also matched a sibling root's `proof.html`.
    - **Rejected with a model-actionable error, never coerced to an empty result:** a path outside every open folder (the message names the path and lists the open folders), `..` traversal that escapes a root (rejected, not clamped — clamping would silently search a file the caller did not ask for), a path inside more than one open folder (ambiguous; set `root` to disambiguate), an absolute path when no folder is open, the open folder itself, and a blank entry. On Windows this includes UNC (`\\server\share\…`) and drive-relative (`\foo`) shapes, which must reject rather than fall through to relative handling; drive/segment comparison is case-insensitive on win32 only.
    - **`filePaths: []` means "nothing allowed"** in both passes — `undefined` is the only spelling of "no filter". The two used to disagree, with `[]` scoping the index to nothing while the live pass walked everything.
    - Scope errors are on `runGrepSearch`'s known-safe passthrough list (`/^filePaths /`), so they reach the model instead of becoming the generic "Try again."

2. `brainstrike.queryEmbeddingSpace` — semantic search when exact wording is unknown.
3. `brainstrike.hybridSearch` — vector + full-text keyword RRF fusion for the assistant, reusing the
   SAME `HybridSearchService` as the UI (desktop wiring in
   apps/desktop/src/assistant-server/hybrid-search-tool.ts, which reuses the retrieval
   tool's exported embedding-set/embedding helpers so scoping — explicit
   `embeddingSetId` or Workspace Index, optional `root` → `rootIds`, explicit input
   `filePaths` (max 500, matching the repos' inline cap) — matches
   `queryEmbeddingSpace`'s explicit-input semantics: like that tool, it does NOT
   inherit the implicit UI selection (`omitImplicitContextRuntimeData` parity), and
   it takes no selectionSnapshotId input. The keyword arm is embedding-set-scoped in
   the repos (coverage-identity predicate: chunk set, or NULL chunk set + file-record
   set), so fusion can never surface keyword-only chunks from another embedding space;
   both source pools grow with the requested limit (min 50), mirroring the UI
   executor). Best default when a query mixes conceptual
   intent with distinctive exact terms. NO SILENT FALLBACK: a failing keyword arm
   fails the call visibly, never degrades to vector-only.
   Gated by the hybrid RRF eval (packages/db/src/evaluation/hybrid-eval-runner.ts +
   hybrid-golden.ts, wired into `pnpm eval:retrieval` and
   packages/db/__tests__/search-hybrid-eval.test.ts): the golden set is designed so
   NEITHER pure arm ranks every target first but the fusion does (precision@1 = 1,
   MRR = 1 strict), and the runner fails if either pure arm reaches precision@1 = 1
   (the set would no longer separate the arms).
4. Hybrid FTS+vector RRF fusion (`HybridSearchService`) backs UI search paths. The
   lexical arm matches with built-in PostgreSQL FTS over migration 034's
   generated tsvector + GIN index and orders those matches with the
   migration-066 pg_textsearch BM25 index plus an `id` tiebreaker; the caller's
   language and query mode remain authoritative for matching (BM25 orders but
   never matches — see `docs/agents/database.md`). RRF fuses rank positions,
   so the fusion layer is unchanged.
5. Web retrieval pair (external service — Tavily via the shared `'tavily'`
   secrets-store key, env `BRAINSTRIKE_TAVILY_API_KEY`/`TAVILY_API_KEY` first):
   `brainstrike.webSearch` (snippets; provider-native search swapped in on
   Anthropic/OpenAI for fresh allowed turns) and `brainstrike.webExtract`
   (report R5 — reads up to 5
   PUBLIC pages behind results/user URLs as markdown, Tavily `/extract`; it has
   NO provider-native swap and must stay Tavily-backed). Both are keyless-
   HONEST (`available:false` + actionable message, never a throw) and
   non-fatal on network errors. webExtract additionally validates every
   model-supplied URL BEFORE anything is sent (http/https only, no embedded
   credentials, no private/loopback/link-local hosts — IPv4 literal ranges +
   IPv6 `::1`/`fe80::/10`/`fc00::/7`; public hostnames are NOT DNS-resolved
   locally since the fetch runs on Tavily's servers, the guard keeps clearly
   internal URLs from leaving the machine) and reports every refusal per-URL
   in `failed` — never a silent drop. Its producer preserves complete page
   content, URL identity, and failure reasons; it never clips a page or asks the
   model to re-fetch a changed source. Inline results receive a purpose-built
   complete projection. Results above 2400 serialized characters use the
   central artifact settlement path before projection, which retains exact
   UTF-8 JSON and gives the model an opaque `brainstrike.readToolOutputArtifact`
   cursor only when unread bytes remain. A one-page settlement stays complete
   without an EOF cursor. Without durable settlement, an oversized result
   surfaces an explicit model-output-unavailable state while its raw application
   result remains intact. Hermetic tests:
   `apps/desktop/src/__tests__/assistant-server/web-extract-tool.test.ts` and
   `web-extract-model-projection.test.ts`.

   Approval resume is the deliberate exception to that fresh-turn swap only
   when Mastra's durable suspended-call snapshot identifies the exact resumed
   tool as `webSearch`. If a read grant changes that call from ask to allow, the
   rebuilt immutable runtime keeps its execute-backed Tavily implementation;
   replacing it with the provider-native definition would orphan the durable
   function invocation and complete without executing or continuing. Resuming a
   different tool keeps provider-native search available, and the next fresh
   turn observes the grant normally.

Vector search adaptive routing (selective-filter recall fix): `searchSimilar`
in ALL THREE chunk repositories — `FileChunkRepository`,
`ElectronFileChunkRepository`, and `DrizzleFileChunkRepository` (the web/
DbProvider path) — routes NARROWED
searches (any filter beyond `embedding_set_id` — rootId/rootIds, filePaths,
selectionSnapshotId, fileRecordId, chunkType) via bounded selectivity counts
(`resolveFilteredVectorSearchRoute` in packages/db/src/repositories/_shared.ts):
a filter matching ≤20k rows AND ≤15% of its set bypasses the partial halfvec
HNSW index with an exact full-precision `embedding <=> $1::vector(N)` scan
(the expression cannot match the index, so the planner exact-scans — 100%
recall). Benchmarked: the ANN path returns 39.8% recall@10 at 100k chunks with
a ~10% filter AT THE SAME latency as the exact scan; `hnsw.max_scan_tuples`
and per-root partial indexes were measured and rejected
(docs/binary-quantization-two-stage-benchmark-2026-07-11.md). Un-narrowed
whole-set searches never run the counts. Do not "optimize" selective filtered
searches back onto the ANN index without re-running that benchmark.

Tool output budget (anti-thrash contract): budgets are token-denominated at 4
chars/token (mirrors `countTokensHeuristic`). The two default budgets are
resolved once per Mastra run from the active model context window; explicit
per-tool overrides remain fixed and authoritative. Native producers self-bound
result lists via `fitItemsToCharBudget`. Purpose-built domain projections
(`readWorkspaceFile`, `grepSearch`, `globWorkspace`, `querySelf`,
`findWorkspaceSymbol`/`lspInspect`, workspace-context, and
workspace-retrieval, plus `webSearch` and `webExtract`) use decoded text length
for their self-fit contract. `MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET` is the
6000-character 128k anchor definition, not a universal per-run value. Desktop
projectors now self-fit against the run's resolved domain value; the fixed
constant remains the backward-compatible fallback only when no resolved budget
was threaded by a harness or nonstandard host.
`decodedWorkspaceTextModelOutputChars` counts code points in the value the
model actually reads and adds the small fixed
`PROJECTION_ENVELOPE_RESERVE_CHARS` reserve; it does not measure
`JSON.stringify(...).length`. A newline therefore costs one character, not
two, so line-dense pages fit roughly twice as much content at the same budget
as they did before BST-1195. The generic/default non-domain projection path
and the `boundToolOutputForModel` transport guard still measure serialized JSON
characters. The generic model-result ceiling remains 8000 characters; the
transport default is the resolved per-run value described below.
If the requested page exceeds the envelope, it shortens the page and returns a
26-character random `nextCursor` handle that resumes at the exact source line
and column, including within a long generated/minified line. The authoritative
root id, path, requested range, byte size, mtime, and source position remain in
the main-process registry and are never echoed through the model. Handles are
bound to the originating assistant resource/thread, expire after one hour,
survive renderer reload while the desktop main process remains alive, and are
cleared by factory reset or process restart. A handle is released only after its
continuation page has been validated and built successfully, before the next
handle is issued, so failed reads remain retryable while completed pages do not
occupy registry capacity for the rest of the TTL. Malformed, unknown, expired,
released, cross-thread, cross-root, and stale-file continuations fail visibly;
there is no legacy-cursor decode or fresh-read fallback. `omittedChars` counts
exact unread source characters; when a page ends after a complete line, that
includes the source newline before the next line.
Desktop reads each page from one containment-checked file handle: the same
handle is statted before and after the read, binary-probed, and decoded as fatal
UTF-8 in 64 KiB chunks. It retains only page-sized source fragments plus line
and character counters; it still scans to EOF because `totalLines` and
`omittedChars` are exact public metadata, never estimates. Full-file allocation
remains reserved for consumers that require the complete source, such as symbol,
LSP, and tapestry-range processing.
Pass `nextCursor` back unchanged as `cursor` with optional `maxChars` and no
other fields. `path` and `root` are initial-read inputs only and non-null
continuation overrides are rejected. A provider-emitted replay of the original
`startLine` or `endLine` is tolerated only when it exactly matches the
registry-bound range; a changed range fails visibly.
Optional
cursor, range, root, and character-cap fields accept provider-emitted `null` as
omission; invalid non-null values still fail schema validation. Both fit
`NATIVE_TOOL_RESULT_TOKEN_BUDGET` (2750) before settlement. The Mastra
runtime then adds or composes `toModelOutput` on every execute-backed
native/MCP tool. PostToolUse context travels only in an internal execution
carrier: Mastra's `transform.display` and `transform.transcript` channels
restore the exact domain result before live UI or durable persistence, while
`toModelOutput` alone consumes the context. Generated/default projections are
bounded to `MAX_MODEL_TOOL_RESULT_TOKENS` (2000) / 8000 serialized characters —
EXCEPT for tools that self-bound their complete result to
`NATIVE_TOOL_RESULT_TOKEN_BUDGET` and rely on the generic projection
(runPython, runSkillScript, skill_read, skill_search, plus the
`fitItemsToCharBudget` default-budget callers without custom projectors —
manageTaskList, readWorkspaceDirectory, queryDiagnostics; the
`skill` activation keeps its dedicated 6000-token envelope; `executeCommand`
has its own text projection — BST-1201 below — and keeps its override entry
only for the dispatcher fail-soft fallback). Those are
enumerated in `MODEL_PROJECTION_BUDGET_OVERRIDES`
(packages/agent/src/mastra/tool-model-output.ts) with the wider
`NATIVE_SELF_BOUND_*` envelope: 2x the native budget plus the structural
reserve, sized for worst-case JSON re-escaping of an embedded serialized
payload, so the tool's own head+tail retention and truncation hints (BST-1189)
pass through the default projector unmodified instead of being replaced by the
generic prefix preview. Regression guard:
`packages/agent/src/__tests__/tool-model-output.spec.ts`, "self-bounded native
tool results".
Purpose-built domain projections have a stricter resolved contract so the
remaining envelope can carry PostToolUse guidance. The
`MAX_DOMAIN_MODEL_TOOL_RESULT_TOKENS` (1500) / 6000-character constants define
the 128k anchor tier. Domain projectors MUST
self-fit a complete page; central code throws on overflow instead of
prefix-truncating a page whose continuation/provenance it cannot understand.
Only generated/default projections may use the generic truncation path.
Projector throws are two different contracts, distinguished by an explicit
marker (2026-08-03: a failed tool's value reaching the grep projector turned
into a fatal run error that destroyed the underlying diagnostic). A projector's
SHAPE-VALIDATION paths — "this value is not my tool's result at all" — throw
`ToolProjectionInputRejectedError` from `@brainstrike/agent`; the runtime
dispatcher degrades ONLY that marker to the generic bounded projection and logs
`tool_model_projection_fail_soft` with a keys-only shape summary that names the
trigger. Every OTHER projector throw is deliberate contract enforcement — a
limited result without continuation guidance, a non-advancing page, a self-fit
budget guard — and still fails the run, whether thrown inside the projector or
raised centrally on an oversized returned value. When adding a projector,
choose per throw site: marker for "not my result", plain error for "my
producer violated its contract".
Mastra's tool-input/output validation failure carrier
(`{error: true, message, validationErrors}` — `@mastra/core` `ValidationError`)
never reaches domain projectors at all (BST-1249): the dispatcher routes it to
the generic bounded projection alongside guarded tool errors, both bare and
nested under the AI-SDK `{input, output, toolCallId}` result envelope. It is an
EXPECTED shape for a mis-parameterized call, so it must not burn an
error-severity `tool_model_projection_fail_soft` — that log exists to flag
genuinely unexpected shapes (pinned in `tool-model-output.spec.ts`).

### Context-window-scaled default budgets

`createMastraAgentRuntime` resolves the active model once in
`packages/agent/src/mastra/agent-runtime.ts` via `resolveToolResultBudgetForModel`,
which reads the catalog `contextWindow` (`findLlmModelDefinition`, non-throwing)
and calls `resolveScaledToolResultBudget`. A budget default is NEVER a hard
precondition for starting a run: `getLlmModelDefinition`'s throwing form is not
used here, because the static registry is a curated subset (OpenRouter
metadata-only/auto-profile models, and persisted preferences from a retired
catalog entry, are routinely absent from it) and a budget lookup failing must
never kill a run. Runtime-discovered Ollama and LM Studio ids use the shared
conservative 32,768-token declaration from `@brainstrike/assistant-contract`
(`DYNAMIC_LOCAL_MODEL_CONTEXT_WINDOW`); every OTHER unknown provider/model id
falls back to the 131,072-token ANCHOR — the exact pre-BST-1206 fixed-budget
behavior — with a visible `tool_result_budget_unknown_model_fallback` warn log
(not a silent fallback: the documented default, logged). A genuine registry
misconfiguration (a registered entry with an invalid `contextWindow`) still
throws through `resolveScaledToolResultBudget`'s own validation rather than
being swallowed as "unknown model". The plain resolved carrier is threaded
through MCP inline bounding, the core and deferred discovery surfaces, persona
projections, and `RunTokenDiagnostics`. The sole module-scoped context is the
save/restore `activeToolResultBudget` around one synchronous custom-projector
call: it is not run state, is never held across a Promise, and exists because
Mastra's `toModelOutput(output)` signature cannot carry the per-call budget
when a persona re-projects a parent-owned tool object.

BST-1219 (done; follow-up to PR #2349) closes the producer/guard seam for fresh
desktop projections. `packages/assistant-service/src/stream-init.ts` normalizes
the trusted provider, applies the same default-model fallback, resolves the
budget before `capabilities.tools.build`, and carries it in
`AgentStreamToolDependencies.resolvedToolResultBudget`.
`buildDesktopAssistantTools` captures its domain-character value in every
purpose-built projector only as a fallback for direct callers and in
`readWorkspaceFile`'s page fitter. Wrapped parent/persona projection calls read
the active resolved carrier synchronously, so the SAME desktop tool object can
narrow or widen for a pinned child's own budget. `readToolOutputArtifact` uses
that seam too; its page and search projectors self-fit against the passed
domain budget instead of the fixed 6000-character anchor. The later
Mastra runtime independently resolves the same provider/model pair once for
its guard and transport pipeline; `stream-init-tool-budget.test.ts` pins parity
between those two resolutions. Invalid providers remain a visible anchor
fallback at the earlier construction seam and still fail normally at runtime
configuration; an unknown model retains the resolver's single documented warn.

The anchor is 131,072 context tokens. Defaults scale linearly and round to the
nearest token: domain is `round(1500 * contextWindow / 131072)` clamped to
500..3000 tokens (2000..12000 characters), while transport is
`round(3000 * contextWindow / 131072)` clamped to 1000..6000 tokens
(4000..24000 characters). Thus a 128k model retains byte-identical 1500/3000
behavior and no model exceeds the settled 2x small-page ceiling. Domain-level
per-tool entries in `MODEL_PROJECTION_BUDGET_OVERRIDES`
(`packages/agent/src/mastra/tool-model-output.ts` — `executeCommand`, `skill`,
`runPython`, and the rest of the `NATIVE_SELF_BOUND_*`/`SKILL_ACTIVATION_*`
group) stay fixed, unscaled, at every tier — they key off their OWN dedicated
constants (`NATIVE_TOOL_RESULT_TOKEN_BUDGET`, `SKILL_ACTIVATION_RESULT_TOKEN_BUDGET`),
not the domain/transport pair this section scales, and are out of BST-1206's
scope.

Transport-level per-tool entries in `TOOL_RESULT_TOKEN_BUDGET_OVERRIDES`
(`packages/agent/src/stream/tool-output-limits.ts` — currently just `skill:
6000`) are DIFFERENT: an override authored against an implicit 128k assumption
is not really an explicit per-model decision, and on an 8192-token Gemma run
the fixed 6000-token `skill` override alone is ~73% of the entire context for
one activation. So these overrides scale WITH the resolved transport budget —
but only DOWN, never up: at or above the anchor (the resolved transport budget
`>= MAX_TOOL_RESULT_TOKENS`), an override wins unchanged (overrides are
ceilings authored deliberately, never inflated past what their author chose).
Below the anchor, an override scales by the SAME factor as the generic
default — `round(override * resolvedTransportTokens / MAX_TOOL_RESULT_TOKENS)`
— floored at the generic 1000-token transport floor so no override collapses
to something unusably tiny. `resolveOverrideTokens` in `tool-output-limits.ts`
implements this; `boundToolOutputForModel`'s `scaledDefaultTokens` param is the
resolved value used for both the generic fallback and this override scaling.

Replay validation is deliberately asymmetric. A fresh purpose-built projection
uses the current run's resolved default. A stored/settled projection may have
been produced by a larger-window run, so replay always validates the default
domain portion against the fixed ceiling tier (3000 tokens / 12000 characters),
never the possibly smaller current run value. The out-of-scope total model
envelope (`MAX_MODEL_TOOL_RESULT_TOKENS` / `MAX_MODEL_TOOL_RESULT_CHAR_BUDGET`,
2000 tokens / 8000 characters) and every domain-level `MODEL_PROJECTION_BUDGET_OVERRIDES`
entry remain unchanged at every tier, on both fresh and replayed projections.
Because that total envelope never scales, replay's newly-composed hook context
(`composeHookContextWithProjection`) is fitted against the SAME fixed
8000-character ceiling whether the stored domain payload came from a
huge-window run or the current run's own resolved tier — a known, documented
tradeoff, not yet fixed; see `docs/agents/assistant-runtime.md`'s replay
section for the full reasoning. BST-1219 widened budget context only for FRESH
desktop producers; the replay hook-context/total-envelope tradeoff remains a
separate deferred follow-up and was not changed.
The file-read staleness tracker is updated only after cursor validation and
page construction succeed inside the per-file lock; a rejected stale cursor
must not mark externally changed bytes as fresh for a later write.

Guarded failures (`tool_timeout`, `tool_failed`, `tool_input_invalid`,
`tool_blocked_by_hook`) bypass domain projectors and retain the bounded
structured failure. Generic throws remain redacted as `tool_failed`; trusted
application-owned `ToolInputError` validation failures preserve their safe,
model-correctable message. Multi-root resolution uses that path when a
root-qualified tool misnames or ambiguously names `root`. An omitted selector
uses `boundWorkspaceRootId` only when request preparation has durably bound the
thread to a live DB root; without that binding, ordinary single-target tools
retain the visible ambiguity error. Search tools whose legacy omission meant
"all roots" narrow to the binding when one exists and retain all-root behavior
only for genuinely unbound requests. Their provider schemas state that omission
rule and direct a bound thread to call once per root id when it needs every
folder. An explicit selector for another live mounted root is an observable
cross-root call. A stale/disconnected binding returns the explicit
`bound_workspace_root_unavailable` HTTP 409 initialization failure and never
falls back to Main. Successful resolution logs the mode and
safe root id/name, and native results surface `rootName` in the tool card. The
default multi-root instruction includes
deferred `lspInspect`, so a newly activated semantic tool receives the same
root-qualification rule as reads and searches. Correctable multi-root errors
list complete `displayName (id rootId)` choices within an 800-character budget;
if the inventory exceeds that budget, they direct the model to
`listWorkspaceContext` rather than truncating an identifier.
`lspInspect` also brands its identifier/marker, line-range, missing-fragment, and
ambiguous-fragment rejections as trusted input errors. A markerless single
JavaScript/TypeScript identifier is the preferred model input and anchors the
cursor at its unique occurrence on the requested line; a repeated occurrence
still requires the exact `<<<` fragment form. A wrong-line markerless identifier
returns bounded candidate line numbers for an explicit retry and never silently
moves the request. Its catalog description spells out the `LSP` acronym so the
common `search_tools("lsp")` query finds it; `load_tool` then loads it by exact
name.
The desktop LSP pool is keyed by the durable database `roots.id` returned by
workspace-tool resolution. Root disconnect therefore evicts every LSP pool
entry using the durable ids returned by the path-keyed database transition,
never the renderer adapter id from `rootsList`; those identities can diverge
after remove/re-add reconciliation.
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

MCP text/JSON uses a separate temporary inline ceiling only when the host does
not supply durable artifact settlement: it is bounded to
the active run's resolved transport default. `MAX_TOOL_RESULT_TOKENS` (3000) is
the 128k anchor; the resolved range is 1000..6000 tokens. Multimodal output
always stays inline so the
display/transcript channels can render it; durable settlement never converts
image/audio `content` arrays into text artifacts. Raw media is permitted only
up to the assistant aggregate encoded-media ceiling and 12000 non-media
serialized characters in both host modes. Multimodal `content` arrays
containing any non-object part are malformed and throw before persistence
accounting. Exceeding either ceiling throws visibly—never drops media.

The browser-safe `@brainstrike/assistant-contract/tool-output-artifact`
subpath defines the versioned foundation for that replacement: an opaque
artifact reference, a bounded provider-facing preview envelope, and contiguous
UTF-8 byte-addressed continuation pages. Artifact ids and cursors accept only
bounded opaque tokens—never filesystem paths, URLs, thread ids, or storage
locations. Preview and page fields are capped at 8000 UTF-8 bytes after outer
JSON string serialization as well as 8000 decoded UTF-8 bytes, so ordinary JSON
escaping or persistence-safe encoding cannot expand the provider-facing field
past its budget. Page guards decode that bounded content before verifying the
declared byte span, require a continuation cursor exactly when bytes remain,
and reject gaps, overlaps, extra fields, unsupported encodings, and malformed
versions instead of guessing. U+0000 content uses an explicit reversible
`json-string` encoding because PostgreSQL jsonb cannot represent it directly.
Migration 068 and `ToolOutputArtifactRepository` provide exact UTF-8 `BYTEA`,
resource+thread-scoped bounded range reads, seven-day expiry, bounded
oldest-first purge, typed visible failures, and explicit web/desktop
factory-reset cleanup. Exact replay of one scoped tool call is idempotent only
when format and complete bytes match; a conflicting replay is a hard failure.

`applyToolOutputArtifactSettlement` is the central live settlement seam. With a
trusted host store, persona tools use that same seam after their own permission
selection and before their own model projection. Reader eligibility comes from
the child's final tool map; MCP truncation uses the child's resolved model budget.
Missing child execution scope or an eligible reader fails visibly before storage.
Native function tools carry execution scope through Mastra's public memory
RequestContext parser; ToolAction contexts can carry `agent.threadId` directly.
Both feed the shared execution-identity reader, never tool input.

Non-media native and MCP output above 12,000 UTF-8 bytes is
retained completely before display/transcript receives the bounded envelope. A
tool may also declare a stricter canonical-name serialized-character ceiling
when its complete domain projection must fit below that generic transport
threshold. Desktop sets `brainstrike.webExtract` to 2400 characters so
escape-heavy inline source still fits the 6000-character domain projection;
larger extracts use the same durable artifact format and an exact cursor only
when unread bytes remain. A settlement that fits one model page retains the raw
display and returns `complete: true`; a host without a durable store receives
an explicit model-output-unavailable projection instead of clipped source or a
projection exception.
A private carrier retains the original result without leaking it into
persistence.
After settlement, `toModelOutput` bypasses the original domain projector and
projects a bounded initial-page view, composing authenticated hook context
centrally. That model view omits the redundant artifact reference, exposes one
exact reader/cursor action, and recomputes the cursor if its preview must shrink
to fit the domain budget; otherwise smaller models can combine mutually
exclusive initial and continuation inputs. MCP image/audio stays inline under
the media ceilings above instead of being serialized into a text artifact. The upstream
settlement cap for pageable text/JSON is 16 MiB;
over-cap output, missing tool-call provenance, serialization failure, storage
failure, or incoherent storage metadata throws visibly.
Without the capability, the temporary MCP ceilings above remain authoritative.
Desktop injects the settlement store only for a server-owned run with resource,
thread, and run scope; the paired reader needs server-owned resource and thread
scope but no new run id. The shared resolver accepts one strict discriminated
input: either the initial artifact reference or an opaque continuation cursor.
The cursor binds its version, complete reference identity, expiry, byte length,
format, and exact next offset; envelope and page guards reject a cursor whose
identity or offset differs. The resolver reads through a server-created
capability closed over resource+thread scope, returns contiguous fatal-UTF-8
pages with reversible U+0000 encoding, and surfaces malformed, expired,
wrong-scope, incoherent, non-progress, and storage failures as typed errors.
Settlement and continuation pages use the same cursor encoder. Desktop
registers `brainstrike.readToolOutputArtifact` only when that scoped capability
exists; web and requests without complete memory scope omit it instead of
stubbing it. The shared resolver retains its strict initial-reference and
continuation modes for internal callers, while the registered native model tool
exposes the required opaque `cursor`, optional `maxBytes`, and optional search
fields `pattern`/`isRegex`/`caseSensitive`. Search composes with paging: the
cursor selects the starting byte and omitting `pattern` preserves the raw-page
path. Settlement
always creates that cursor, so removing the redundant mode/reference fields
prevents smaller models from fabricating contradictory calls and shrinks the
provider schema. Its raw result is the guarded artifact page or typed search
slice for display and persistence. Its purpose-built model projection omits the
repeated artifact reference: paging retains format and byte offsets and carries
either `complete: true` or an exact next tool/input pair; search emits the same
compact `grep content` header and `line: text` rows as workspace grep, with
1-based line numbers local to the scanned byte slice. Search projection reuses
the shared header/row formatter and must attach an actionable cursor whenever
source bytes or matches remain omitted; a limited result without guidance
throws, while a complete zero-match result is valid.
If JSON escaping plus continuation metadata would exceed the 6000-character
domain budget, the projector fits a shorter code-point prefix and recomputes
the cursor at that byte boundary; it never generically truncates content or
loses continuation state.

Finally, the UI transport independently applies the generic transport backstop.
Callers inside an active run use the resolved 1000..6000-token default; the
context-free data-stream mapper retains the 3000-token anchor fallback because
its replay/session boundary has no active-model carrier.
Oversized collections
(matches/entries/results/items/files/chunks/rows/subAgentToolResults) are
structurally trimmed; opaque outputs become a SUCCESSFUL
`tool_result_truncated` preview with an actionable hint. An opaque preview
retains a balanced 50/50 head and tail around an explicit omitted-character
marker, with both UTF-16 cut points snapped away from surrogate-pair interiors;
it no longer discards all trailing evidence. The legacy
`tool_result_too_large` envelope remains readable only for persisted-history
compatibility, and untrusted envelope-shaped output is revalidated against the
active budget. Proofs:
`tool-model-output.spec.ts`, `tool-output-limits.spec.ts`,
`projection-aware-token-limiter.spec.ts`,
`mastra-tool-execution.integration.spec.ts`,
`mastra-memory-persistence.integration.spec.ts`, and
`data-stream-session.spec.ts`. `listWorkspaceContext` is concise by default
(counts + token budgets); `detail: true` returns per-file Tapestry ranges.
`grepSearch` and `globWorkspace` keep their complete typed raw pages for
display, persistence, hooks, and reload, but their Mastra `toModelOutput`
projections are deterministic line-oriented text. Content mode returns NO
context lines unless the caller opts in (`contextLines` defaults to 0 —
BST-1193: searches locate, reads understand; the schema's `.describe()`
text and the tool fallback must state the same default — the inspector
display is derived from that schema (`toToolSchemaDisplay`, BST-1646), so
there is no longer a second mirror to keep in step). Since BST-1185 those
projections are PATH-GROUPED and happy-path-silent: one file header per file
(`rootName:path`, root prefix only when the producer's `openRoots` reports
more than one open folder — the display name is a valid `root` selector, and
two same-named roots fall back to root ids), then `line: text` rows with `-`
marking context rows; files mode emits `rootName:path:firstLine (N matches)`
per line. Engine/limit flags (`live=`, `candidates_truncated`,
`scan_limited`, `skipped_lines=`) appear in the header ONLY when they fire;
the read recipe lives once in the grepSearch/globWorkspace tool descriptions
instead of a per-row `read_args` envelope (the legacy per-row format cost
~180 chars/match). Continuation guidance is unchanged and authoritative, and
everything fits the 6000-character domain budget. Stored projections from
pre-BST-1185 threads still carry the legacy `grep <mode> | page=` header; the
replay prefix is the common prefix of both generations, so they replay
byte-for-byte.
Because Mastra's one-argument projector receives the raw result but not the
original tool input, paging guidance tells the model to reuse the prior call;
it never fabricates or duplicates the original pattern. When the whole raw page
fits, the projection preserves the producer's bounded hint because the producer
owns service caps and scan-limit semantics. Only when the tighter projection
budget omits raw page items does the projector calculate an earlier advancing
`offset`. Producer guidance includes an `offset` only when that offset strictly
advances; when search or candidate limits yield an empty page with no reachable
next offset, it instead gives terminal query-refinement guidance. A truncated
result without producer guidance throws instead of guessing. Match lines and
context are clipped with an explicit omitted-character marker; paths and root
labels are NEVER clipped or whitespace-collapsed (a mangled selector is
unusable) — a pathological oversized selector overflows the budget and its
item is omitted with an advancing offset. Root-name ambiguity is decided by
the PRODUCER against the full open-root inventory (`ambiguousRootNames` on
the envelope; `describeOpenRootTopology`), never page-locally. SETTLED
filename-forgery ruling (PR #2313): line breaks and a leading whitespace
character in paths are escaped, so a hostile filename can never create a new
projection line nor mimic an indented match row; a filename that merely
resembles a header or continuation string still renders inline on its own
single line and is an accepted residual — do not reintroduce per-row quoting
to chase it. The grep producer and projector
share one runtime result contract. The projector also recognizes its own
canonical bounded text envelope when Mastra replays a stored model projection
while preparing a later same-run step; that replay is idempotent and does not
reparse the text as a raw grep result.
`readWorkspaceFile` keeps its complete typed raw result for display,
persistence, hooks, and reload. Its projection-contract raw result fields now
include `openRoots`, `ambiguousRootNames`, and `rootId` in place of the removed
always-null `tokenCount`; the separate raw `approxOutputTokens` estimate remains
outside that projection contract. Its Mastra `toModelOutput` projection emits
a compact `read <root:>path lines <start>-<end>/<total>` header, prefixing a
root selector only when `openRoots > 1`. An unambiguous display name is the
preferred selector; a name listed in producer-owned `ambiguousRootNames` falls
back to `rootId`, matching the full-inventory `describeOpenRootTopology`
policy. Line breaks in both the selector and path are escaped so neither can
forge protocol lines. The page's already-gutter-prefixed content follows
verbatim; the native mutation-side refusal for accidentally pasting that
display form back into file content is specified in
`assistant-runtime.md` under "GUTTER-PREFIX WRITE GUARD (BST-1202)". The header
adds `size` and `omitted` only for a truncated page. A
`continue: cursor=<nextCursor>` footer appears only when a continuation cursor
exists: never when the request fit completely, and never in the registry-less
internal read mode where truncation can occur without an issuable cursor. The
same compact formatter backs the producer's self-fit binary search. It admits
more source content because the single header and optional footer replace the
raw result's fixed metadata-key and object-punctuation overhead; JSON escaping
does not free character-budget room. Its literal wire newlines instead save
model tokens. A stored `{type:'text',value}` beginning with `read ` on a later
same-run step replays byte-for-byte instead of being reparsed as a raw result,
mirroring the grep/glob replay contract. Legacy stored
`{type:'json',value:<raw result>}` projections are unwrapped and re-rendered in
the new text form, and legacy raw results without topology fields degrade to an
unprefixed header without losing content. Nothing else read `tokenCount`, so
the always-null field was dropped from the result entirely.
`executeCommand` keeps its typed raw result for display, persistence, hooks,
and reload; the envelope now carries the selected `rootId` plus the same
producer-owned `openRoots`/`ambiguousRootNames` topology used by workspace
reads. Its Mastra `toModelOutput` projection emits
`exec exit=<code|null> <seconds>` followed by only active `timed_out`,
`killed=<signal>`, `truncated`, and multi-root `root=<selector>` tokens.
Ambiguous display names fall back to the root id and selector line breaks are
escaped. The only exit-code
annotations are the conservative static cases `grep`/`rg` exit 1 (`no
matches`) and `diff` exit 1 (`files differ`); naive leading-token basename
extraction deliberately does not interpret shell prefixes or environment
assignments. Already ANSI-stripped, head+tail-fitted stdout and stderr are
rendered verbatim, with a `[stderr]` section, an explicit `(no output)` body,
and the producer truncation hint last when present; the projector never
double-truncates either stream. Legacy raw results without topology remain
valid and unprefixed, stored `exec ` text projections replay byte-for-byte,
shape rejection uses the dispatcher fail-soft marker, and either fresh or
replayed output above the 6000-character domain budget throws. Proofs:
`execute-command-model-projection.test.ts` and
`execute-command-tool.integration.test.ts`.
`findWorkspaceSymbol` and `lspInspect` keep their complete typed raw results for
display, persistence, hooks, and reload while their Mastra `toModelOutput`
projections emit bounded line-oriented inspection summaries. Symbol output
retains the root/path, 1-based declaration line and enclosing range,
declaration text, preview, total/truncation state, and honest instructions for
passing the returned unique identifier directly or forming the `lspInspect`
cursor marker when that identifier repeats. It does not invent a symbol
kind or the original symbol query: Mastra's one-argument projector receives the
raw result but not the original input. LSP output retains availability/reason,
language, hover text, diagnostics, and definition/implementation locations.
Projection-only omissions are counted explicitly, malformed result shapes
throw, and raw tool results are never mutated.
`listWorkspaceContext` likewise keeps its complete typed raw result for
display, persistence, hooks, and reload while its Mastra `toModelOutput`
projection emits a bounded line-oriented inventory. It retains the main and
other roots, focused-root id, selected-file page and outside-workspace count,
index state, token estimates, concise curated-token totals, and detailed
Tapestry ranges when requested. It reserves one advancing selected-file entry,
then fits the multi-root inventory before spending the remaining budget on
selected paths, so a large selection cannot hide the root ids required by
follow-up tools. Path rendering preserves repeated and boundary whitespace;
only line-breaking characters are escaped and overlong paths are explicitly
clipped. Projection-only omissions are explicit. When the projection cannot
retain the whole producer page, its continuation uses the exact advancing
selected-file offset; malformed, incoherent, or non-advancing producer results
throw instead of falling back to generic JSON.
An authoritatively resolved zero-root Desktop workspace is a successful compact
result with `workspaceRoots: []`, null main/focused identities, and an explicit
`roots=0` model line. An absent or malformed root-resolution result still fails
visibly and is never coerced to that valid empty state.
`queryEmbeddingSpace` and `hybridSearch` retain their typed raw results while
purpose-built Mastra projections emit bounded workspace evidence. Semantic
retrieval keeps the producer's canonical ranked, root-qualified context string
plus compact score and token-budget state; explicit clipping reports omitted
characters and a refinement action. Hybrid retrieval retains fused rank,
root/path, chunk identity, RRF/vector/FTS provenance, bounded excerpts, source
coverage, and producer-owned truncation guidance; path rendering preserves
repeated and boundary whitespace while escaping line breaks. Unavailable
Workspace Index state remains visible, malformed or incoherent results throw,
and neither projection mutates the execute result.
The execute-backed Tavily `webSearch` tool likewise retains its normalized raw
result for display, persistence, hooks, and reload while its Mastra
`toModelOutput` emits a bounded ranked-citation list. The projection retains the
query, availability/error state, producer count/truncation guidance, stable
rank, title, exact citation URL, and bounded snippet. Citation URLs are
JSON-escaped but never clipped or summarized: a citation is admitted whole or
omitted whole, with explicit projection omission and query-refinement guidance.
Malformed or incoherent results, including truncated producer output without a
hint, throw visibly. Provider-native Anthropic/OpenAI web search remains owned
by the provider adapter and does not pass through this execute-backed Tavily
projector.

Native-tool catalog ownership (BST-1646): ONE `defineNativeTool` declaration
per tool, everything else derived.
- `packages/assistant-contract/src/native-tools/definitions/*.ts` — one file per
  tool declaring its id, model-facing description, registered Zod
  `inputSchema` (wrapped once in `providerCompatibleInputSchema`), load/risk
  `defaults`, `discovery` namespace + capability family, `surfaces`
  (desktop/web/local), history posture, non-durable output, and inspector
  `returns` prose. `native-tools/index.ts` is the ONLY list (`NATIVE_TOOLS`);
  `deriveNativeToolRegistries` produces every registry from it under its
  historical export name: `NATIVE_TOOL_ID`, the id partitions
  (`DESKTOP_/WEB_/LOCAL_DESKTOP_/SKILL_/NON_DURABLE_…`), `TOOL_DESCRIPTIONS`,
  `NATIVE_TOOL_DEFAULTS`, `NATIVE_TOOL_DISCOVERY_NAMESPACES` membership,
  `DEFERRED_CAPABILITY_FAMILIES`, the two history allowlists
  (`RECENCY_PRUNABLE_` / `STALE_REPLAYABLE_NATIVE_TOOL_IDS`), and the prompt
  composer's model-facing name map. `defineNativeTool` throws on an
  undeterminable risk bucket, a deferred tool without a namespace, or a
  critical tool with one. `NATIVE_TOOL_SCHEMAS` (the settings inspector
  display, and the built-in local model's tool schema via
  `toLocalRuntimeInputSchema`) is DERIVED from each definition's
  `inputSchema` by `native-tools/display.ts` (`toToolSchemaDisplay`, Zod 4
  `z.toJSONSchema` in `io: 'input'` mode — the same conversion the provider
  wrapper runs), so parameter names, types, required-ness, enum options,
  defaults, and bounds cannot drift from the wire. A parameter's prose is its
  `.describe()` text; a definition's `display` map adds inspector-only prose
  (never sent to the model) for a field whose wire description is absent or
  terser than a human reader needs, and a key naming no parameter throws at
  derivation. `NATIVE_TOOL_SCHEMAS` is NEVER an execution or provider-schema
  source.
- `packages/agent/src/tools/schemas.ts` exports `NATIVE_TOOL_INPUT_SCHEMAS`,
  derived from the desktop definitions' `inputSchema` objects (the Zod modules
  themselves live in `packages/assistant-contract/src/native-tools/schemas/`,
  exported as `@brainstrike/assistant-contract/native-tool-schemas`, and are
  re-exported from the historical `packages/agent/src/tools/schemas-*.ts`
  paths for one release — edit the contract package, never the agent shims). Desktop provider
  registration and `validateToolInput` reuse those same schema objects. Mastra
  converts them to provider JSON Schema through the Standard Schema input
  protocol; never reconstruct validation or provider schemas from the lossy
  display metadata.
- Agent Skills (`skill`/`skill_read`/`skill_search`) are `kind: 'skill'`
  definitions: Mastra executes them, but the provider contract Brainstrike
  imposes (`providerDescription` + `inputSchema` in `skill-tools.ts`) comes
  from the definition, and they are not entries in `NATIVE_TOOL_INPUT_SCHEMAS`.
  The separate desktop-only `brainstrike.runSkillScript` is a Brainstrike-owned
  typed execution tool and therefore is present in the desktop catalog/schema
  map, deferred `skills` namespace, and execute-risk policy; web and the
  built-in local model omit it.

Provider-emitted `null` has one fleet-wide meaning for the registered native
catalog: on an optional or defaulted field it is omission, never a second domain
value. `providerCompatibleInputSchema` in
`packages/assistant-contract/src/native-tools/schemas/provider-compatible-input.ts`
(re-exported by `packages/agent/src/tools/provider-compatible-input.ts`) wraps
each complete registered input once. One immutable traversal of its strict input JSON Schema
removes `null` only from declared properties absent from `required`, including
properties nested in arrays, tuple positions, uniquely const-matched
`oneOf`/`anyOf` branches, and unions with exactly one structured branch matching
the input's object/array kind. Dynamic record values (`additionalProperties`)
and ambiguous union branches are not omittable fields. Authored intersections
(`allOf`) and structured record values (an object-valued
`additionalProperties`) are intentionally unsupported traversal shapes for the
registered catalog. A catalog invariant converts every authored schema with the
same `{ cycles: 'throw', io: 'input', reused: 'inline' }` options and reports the
tool id plus JSON path if either unsupported shape appears. Boolean
`additionalProperties` values used by ordinary strict objects remain valid.
Input JSON Schema is derived lazily on the wrapper's first parse and memoized for
that wrapper. The paired exact-option catalog parity test eagerly converts every
registered wrapper before merge, so a future recursive or unrepresentable
schema fails in CI rather than first appearing in a live tool call. The authored
Zod schema then runs exactly once, applying ordinary optional/default behavior
before execution, while the wrapper leaves provider JSON Schema unchanged.
Required fields still reject `null`; invalid non-null values still fail their
original validators. Those failures stay observable through the ordinary
Mastra validation result or desktop `ToolInputValidationError`—there is no
coercion, retry, or fallback. Unknown `null` properties remain visible to strict
validation, while nested object-array properties follow the same omission rule.
An optional/defaulted catalog field must not use `null` as a meaningful
third-state such as "clear this value"; model that intent with an explicit action
or discriminator instead. Because provider `null` reaches the same path as
omission, omitted/default behavior must also be the least-capability behavior
and never more permissive than leaving the field unspecified.
The catalog's `ZodPreprocess`-constrained map makes the wrapper exhaustive for
newly registered schemas; server-owned MCP schemas and deprecated or otherwise
unregistered internal schemas are outside this native catalog rule.

Server-owned MCP schemas retain their own omission/null semantics. The MCP
adapter explicitly sets `strict: false` unless the server opts into strictness
through `_meta.mastra.strict`. An omitted strict flag lets OpenAI Responses
normalize optional fields into required ones: the 2026-09-04 Linear request
filled every filter, including `priority: 0`, and returned only no-priority
issues instead of the latest five issues. Do not repair that by stripping
zero, null, or empty arguments: those may be meaningful server inputs. Preserve
the schema and optional fields on the provider wire, with Mastra's original
JSON Schema validation still required before tools/call. The captured real
Mastra/OpenAI request in `mcp-optional-inputs.spec.ts` pins explicit non-strict
generation, required-field preservation, omission at execution, and continued
input validation; `mcp-runtime-client.spec.ts` pins explicit strict opt-in.

Adding or renaming a native tool is one `defineNativeTool` file (listed once
in `native-tools/index.ts`) plus one entry in the desktop executor map
(`apps/desktop/src/assistant-server/native-tool-executors-*.ts`, assembled
into the exhaustive `NATIVE_TOOL_EXECUTORS` — a definition with no entry, or
an entry for no definition, is a compile error) and, when the tool needs
prompt guidance, an `instruction` hook on the definition.
`buildDesktopAssistantTools` is a fold of `DESKTOP_NATIVE_TOOL_IDS` through
that map; an entry returns `undefined` when its capability is absent for the
request (built-in local provider, no artifact reader, no skill resolver). The catalog's
inline snapshot (`native-tools.test.ts`) is the only hand-listed id set; every
other registry derives, so there is no stale, missing, or extra key to drift —
and no fallback alias or partially registered tool.

`brainstrike.manageCanvas` is desktop-only because its source of truth is the
client-local `brainstrike_canvas_versions` ledger. It is a deferred workspace
tool with an `action` discriminated union (`create`, `update`, `rewrite`,
`list`) and explicit `read` risk: updates are DB-backed, versioned, and
reversible, not workspace-file edits, so they must not enter the live Changes
refresh stream. Web has no remote fallback. Conditional instructions advertise
the verbs only when the tool is registered. Settled ruling (2026-08-07, live
gpt-5.6 failure — do not relitigate): the union branches TOLERATE cross-action
extras among the six declared envelope keys (`action` fully determines
semantics; real models bundle fields, and rejecting them broke the feature and
burned retry tokens). Only genuinely unknown keys fail, at the strict provider
envelope.

**The canvas storage ceiling is `CANVAS_HTML_MAX_BYTES` (8 MB), and it is
counted in UTF-8 BYTES.** Two places enforce it, in different packages, from one
constant in `mastra-memory-schema.ts` beside `CANVAS_VERSIONS_TABLE`:

- the `manageCanvas` input schema bounds each incoming HTML **field**, which is
  also what puts `maxLength` in front of the model;
- `insertVersion` in the desktop canvas repository bounds what actually reaches
  the text column, and returns `too_large`. It sits at the choke point on
  purpose: `create` and `rewrite` would otherwise be bounded by the schema
  alone, and `update` composes a document larger than either field it was handed
  — a near-limit document plus an individually valid replacement, repeated.
  `applyUpdate` additionally rejects an over-ceiling composition before
  materialising it, which is an allocation guard rather than a second authority.

Both halves are load-bearing and neither is redundant. `too_large` is the one
failure a model cannot retry its way out of, so `manage-canvas-tool.ts` attaches
a hint naming the limit and telling it to shrink the replacement or start a new
canvas; the descriptions carry `(max 8 MB of UTF-8)` for the same reason, since
the emitted `maxLength` is a character count and would otherwise advertise a
ceiling about four times looser than the enforced one.

One consequence on existing data, stated because neither the schema nor the
hint implies it: a row written before this ceiling existed can sit above it —
the old `.max(8_000_000)` counted UTF-16 units and admitted well over 8 MB of
UTF-8 for BMP-heavy content. Such a row is update-locked except for an update
that brings it under the ceiling in one shot, and `rewrite` is the deterministic
way out, which is why the hint names it. `manage-canvas-tool.ts`
has no size enforcement of its own, so unlike the workspace-file content fields
— which sit above an authoritative ~2 MB byte cap in the desktop tool and
therefore use `.max()` only as a loose outer guard — canvas has nothing
underneath these two checks.

`.max()` alone is not a byte bound: Zod counts code points (4.5; UTF-16 code
units before that), so `.max(8_000_000)` admits eight million astral characters,
31 MB of UTF-8. The `minLength` on `oldString` is applied to the string BEFORE
the byte refinement, because a refinement is not representable in JSON Schema
and expressing it as one silently drops `minLength: 1` from what the model is
told. Paired tests: `canvas-html-byte-ceiling.test.ts` (field) and
`canvas-repository.test.ts` (composed). Both use astral input deliberately —
an ASCII case passes with or without the enforcement.

`brainstrike.queryDiagnostics` is a desktop-only, explicit `read`-risk native
tool over `brainstrike_diagnostic_events`. Its `mode` is required:
`events` returns newest matching rows and `fingerprints` groups recurring
failures with count/first-seen/last-seen plus the latest representative
metadata. Both modes accept exact severity/fingerprint/run/thread filters and
inclusive ISO-8601 `since`/`until` bounds. The schema hard-caps `limit` at 200;
the repository applies the same bound, and the producer additionally
self-bounds through `fitItemsToCharBudget`. Hitting either cap is reported in
`truncated` plus an actionable `hint` — never presented as a complete result.
Web omits the tool because its assistant server has no capability to read the
client-local PGlite database; there is no remote fallback.

`brainstrike.listWorktrees` and `brainstrike.manageWorktree` (BST-1392) are
desktop-only for the same reason as `manageCanvas`: their source of truth —
the git worktree inventory and the `brainstrike_worktrees` ledger — lives on
the client, and web's assistant server has no bridge to either. Spec §6.4
named three tool names (`createWorktree`, `listWorktrees`, `archiveWorktree`);
they collapsed to two ids on the risk split, not on merged capability:
`listWorktrees` is deliberately `read`-risk with no approval, so plan-mode
orientation (an agent listing worktrees before proposing a plan) still works
without interrupting the user, while `manageWorktree` is `execute`-risk with
`requiresApproval: true` and an `action: 'create' | 'archive'` discriminated
union — every mutation still gates through the permission engine exactly as
three separate ids would have, since `create`/`archive` are the only actions
that write. Both tools share ONE `workspace` discovery namespace entry (the
same namespace `manageCanvas`/`manageTaskList` register under), not two,
because they operate on the same client-local capability surface a model
should discover together.

### MCP discovery skip reporting (BST-1602)

`collectCombinedTools` returns `{ mcpDiscoverySkips, tools }`. A skip is DATA;
the loader never decides how loudly it is reported. That coupling was the bug:
`pickMcpDiscoveryLogMethod` sniffed the failure reason and demoted exactly the
two likeliest failures — a message containing `"Connection closed"` and
`mcp_tool_discovery_timeout` — to `logger.debug`, so at `LOG_LEVEL=info` a run
that lost EVERY MCP tool left no record at all. The heuristic is deleted. Every
skip logs at `warn`, unconditionally, and the reason string is never inspected.

Two scopes, one row per ACTUAL failure:

- `scope: 'client'` — `listToolsetsWithErrors()` rejected or lost the timeout
  race, so every configured server contributed nothing. ONE skip, naming every
  server in `serverNames`. Fanning it out per server would report N failures
  where one race was lost.
- `scope: 'server'` — that one server's `listTools` failed (its entry in
  `McpToolsetsWithErrors.errors`). One skip per failing server.

`boundMcpDiscoveryReason` does TWO jobs before the reason becomes run-event
metadata, in this order. It REDACTS URL userinfo and query strings, then BOUNDS
the total length to `MAX_MCP_DISCOVERY_REASON_CHARS` (200, ellipsis included),
slicing by code point so a surrogate pair is never split. Truncation is not
redaction: `sanitizeAssistantRunEventMetadata` redacts by KEY, not by value, and
`fetch failed: 401 for https://host/mcp?api_key=…` is comfortably under the
bound. Before BST-1602 the reason reached at most a `debug` log line; it is now
persisted AND rendered in an always-visible row, so the redaction is what makes
that safe.

`McpDiscoverySkip` is a DISCRIMINATED UNION, not one shape with two optional
name fields: the optional form let a `scope: 'server'` skip with no `serverName`
type-check and render `"undefined skipped for this request"` into a durable row.

Per-server errors are filtered to the run's own `namedServers`. A row claiming a
server "was skipped for this request" must be true of THIS request, and
`listToolsetsWithErrors()` is client-wide.

The skips ride `MastraAgentRuntime.mcpDiscoverySkips` — REQUIRED, never
optional, so an empty array means "discovery was healthy" and stays
distinguishable from "nobody looked". `makeMcpDiscoverySkipChunks` mints one
`mcp.tools.unavailable` run event per skip, and `runTurnAttempts` yields them
from its REQUIRED `preludeChunks` parameter. Only the initial-turn seam
(`createStreamIteratorFromRuntime`) passes a non-empty value, so the rows are
fresh-turn only; the approval- and suspend-resume legs pass `[]` explicitly,
because a resume rebuilds the runtime and re-runs discovery and would otherwise
duplicate the rows on every approval.

**The rows must be yielded INSIDE `runTurnAttempts`, never by a wrapper around
it.** That generator's `finally` calls `runtime.dispose()`, and a generator's
`finally` only runs once its body has STARTED. A wrapper that yielded the rows
first could be cancelled before delegating — the "user hits stop immediately"
case, on a run that already had a degraded MCP surface — leaving the turn
generator unstarted while `firstAttempt` is already a live provider stream, so
the runtime, MCP client and abort listeners all leaked. Wrapper-side cleanup
cannot fix this: `.return()` on an unstarted generator does not run its body
either. Regression test: 'still disposes the runtime when the consumer stops ON
the skip row' in `mastra-streaming.spec.ts`.
The rows precede `run.started` because discovery genuinely happens first, during
runtime construction, and the thread-run row is created by
`repository.createThreadRun` rather than by `run.started`. The durable/timeline
half of the contract is in `docs/agents/assistant-persistence.md`.

Why the run still answers rather than throwing: one flaky MCP server would
otherwise break every chat turn, including turns that never needed that server.
The reduced tool surface is reported, not hidden — which is what the
no-silent-fallbacks rule requires ("throw OR surface visibly").

NOT changed by BST-1602, and still open: `DEFAULT_MCP_TIMEOUT_MS` is 5000, and
although `mcpTimeoutMs` is threaded end to end
(`MastraAgentRuntimeOptions` -> `composeRuntimeToolMap` ->
`collectCombinedTools.timeoutOverrideMs`), NO production caller supplies it —
the only two call sites are an e2e helper and a spec, both passing `undefined`.
So 5s is always the effective production ceiling, including on cold stdio server
startup. Revisit once the run-event rows show how often the race is actually
lost.

### Settings tools-availability indicator (BST-1603)

`connected` is a TRANSPORT fact — the handshake succeeded, not that `tools/list`
returned. The Settings group indicator previously showed one green dot for both,
which is why the packaged E2E could not rely on the row either.

`resolveMcpToolsAvailability` (`packages/settings-ui/src/settings/tools/mcp-tools-availability.ts`)
derives the distinction from the host snapshot the row already has. It is pure
and snapshot-only, so it introduces no second source of truth for connection
state.

**It reports only what it can PROVE.** `tools-unavailable` requires
`catalog.errors.tools` — a positive, settled failure signal that cannot be
produced by a query still in flight. Everything else is `available`.

That narrowness is deliberate and must not be widened without first adding a
settled-vs-pending signal to the snapshot. `McpServerActor` publishes
`state: 'connected'` as soon as the handshake completes, carrying whatever
`client.catalog()` returns SYNCHRONOUSLY at that instant
(`apps/desktop/src/mcp/server-actor.ts:497`), then fills the catalog in later
through a `watchCatalog` subscription (`:481-491`). So "no catalog" and "tools
absent" are the NORMAL state of every healthy server between handshake and
enumeration, on every launch. Reporting them would flash a warning on servers
that are enumerating perfectly — and an indicator that cries wolf is worth less
than no indicator. A server advertising no tools capability at all
(`features.tools === false`) is likewise healthy and never flagged.

The degraded dot uses the semantic `warning` token, NOT the `yellow-500` that
already means connecting/authorizing: a user who cannot tell "still working,
wait" from "settled, and it will never contribute tools" has lost the only
actionable distinction. It carries an `aria-label` and a
`data-tools-availability` attribute, because colour alone is not a signal and a
fill-class assertion in E2E is as fragile as the row state it replaces.

Closing the absence gap — reporting a server whose catalog never arrives at all
— needs that pending/settled discriminator on the snapshot, and remains open on
BST-1632 (follow-up to BST-1603).

### MCP Settings progressive disclosure (BST-1630)

The server row keeps lifecycle state, available controls, tool-availability
failures, catalog content, server/control errors, and malformed or unreadable
credential notices visible. Stdio/client diagnostics stay visible for error and
authentication-required states; healthy-server logs are inside the disclosure.
Protocol policy/generation, OAuth facts, and effective extension advertisements
live inside a native `details` disclosure labeled "Connection details". Failure
diagnostics do not force it open or override the user's DOM-resident open state.
Credential faults use the shared state labels and a persistent polite status region.
The credential status region remains mounted while its content changes, so
later credential faults update an existing live region. Initial faults remain
visibly rendered; automatic initial screen-reader announcement is not promised.
`mcp-connection-details.test.tsx` pins node identity and both fault wordings.
These facts remain available without an additional host call or persistent UI
store. Expanding details never initiates authorization or a lifecycle control.
The disclosure resets on a new server generation; current snapshot facts remain
the sole authority. `mcp-connection-details.test.tsx` covers visibility, recovery
controls, and local expansion. The dated BST-1630 audit records real Electron
keyboard/focus and layout measurements for the production component.

### MCP tool-preference persistence (BST-1615, BST-1621, BST-1623)

`mcp/tool-preferences.json` under `userData` is the user's only copy of which
MCP tools they turned off. It has TWO writers, and every rule below exists
because one of them destroyed data.

**Absence is not failure, and neither is evidence of staleness.** Both write
paths conflated "this id was not in this run's discovery" with "this id is
gone". MCP discovery loses its race routinely (BST-1603: an `npx`-launched
server exceeds the 5s budget on 100% of samples under load), so those are
ordinary runs, not edge cases.

- The LOAD path (`loadToolPreferencesForProjection`) pruned any stored id
  absent from `registeredIds` and rewrote the file (BST-1621).
- The SAVE path (`applyToolPreferenceMutation`) serialised
  `mcpToolRegistry.getAllTools()` — also only this run's tools — as the whole
  file, so one toggle dropped every failed server's choices (BST-1623).

#### Write precedence: read → refuse → merge

`applyToolPreferenceMutation` (`apps/desktop/src/mcp/tool-discovery.ts`) takes a
`ToolPreferenceWriteIntent`:

| Intent | Caller | Reads first | Refuses on `invalid`/`unreadable` | Preserves undiscovered ids |
| --- | --- | --- | --- | --- |
| `merge` | `mcp:tools:enable` / `disable` | yes | **yes** | **yes** |
| `replace` | `mcp:tools:reset` | no | no | no |

`merge` seeds from the stored file (`enabledTools` first, then `disabledTools`,
so an id in both lands disabled — the schema permits the overlap and
re-enabling a tool the user turned off is the harmful direction to guess in),
then overlays this run's registry. A `merge` into a file that could not be read
would degrade into exactly the whole-file replace BST-1623 fixes, so it throws
instead. That is NOT the latched session fault (below): the projection pass can
read the file cleanly and the file break afterwards, so the merge reads fresh.

**The save path retires nothing and has no notion of what "retired" means.** It
only declines to drop what it did not see. Retirement is the projection path's
job, keyed on a server's removal from the MCP config (BST-1621) — never on a
failed discovery, in either path. Do not add a second retirement rule to the
save path; the single authority is what keeps the two writers from drifting.

**The read happens BEFORE the mutation.** A refused write must not leave the
live registry changed: `filterEnabledServerTools` consults that registry for
assistant runs, so mutating it behind a rejected IPC is BST-1615's "the UI says
it worked" defect one layer up. This also keeps the registry snapshot
synchronous with the mutation — there is no `await` between them, so a
concurrent re-discovery cannot be folded into the write.

**The version stamp is a constant, not an echo.** The body serialised is always
the shape this build emits; echoing a newer file's stamp would mark v1-shaped
data as already migrated and no future migration could detect it.

#### Reset is the remediation, so it is never gated

`mcp:tools:reset` uses `replace`: it preserves nothing by definition, so it does
not read the file and is not blocked by the latched fault. This is deliberate.
Reset is the ONLY in-app recovery for a corrupt preferences file — gating it
would leave that user with every remediation blocked and nothing but "edit JSON
in `userData` by hand". A successful reset also CLEARS `toolPreferencesFault`,
because it has just written a readable file; leaving it latched would make the
recovery useless (the file is fine and every later toggle still throws until
restart). BST-1620 owns the *other* recovery case — the user repairs the file
out-of-band and wants the session to notice without a restart.

Reset discards every stored id, including undiscovered servers'. An earlier
revision preserved them by symmetry with the toggle; that was wrong. Reset is an
explicit, labelled discard, not the incidental loss BST-1621 protects against,
and a half-reset that silently leaves entries behind is both surprising and an
unreliable remediation.

#### Both writers take one lock

`withToolPreferencesFileLock` serialises every read-modify-write of the file.
The two writers are on DIFFERENT queues and genuinely interleave: the toggle
runs under `trackConfigOperation` (serialised on `mcpConfigOperationTail`),
while the config-watch path reaches the projection through `trackConfigChange`
→ `registerConfigChange`, which only records into `mcpLifecycleBarrier` and does
not serialise execution. `latestAuthorityEpoch` narrows the window but cannot
close it — that check runs once at operation entry, before the I/O.

Unserialised, the lost update is: toggle reads → the projection prunes and
rewrites → the toggle writes its now-stale merged map and resurrects everything
the prune just removed. Any new writer of this file MUST take the same lock.

Paired tests: `apps/desktop/src/__tests__/main/ipc-mcp-preferences.test.ts`
(merge preservation, both refusal kinds, reset-over-corrupt, fault clearing,
no-mutation-on-refusal, version stamping, and the watcher-vs-toggle
serialisation) and `packages/agent/src/__tests__/tool-persistence.integration.spec.ts`
for the `ToolPreferencesLoadResult` discrimination itself.

### Tool discovery contract (LIVE for hosted Mastra catalog search)

`packages/assistant-contract/src/tool-discovery.ts` is the authoritative
adapter and loading-tier contract. `createMastraAgentRuntime` now selects
`mastra-catalog-search` explicitly for hosted routes, constructs the Agent from
the post-gate critical/custom surface, and gives only the post-gate deferred
surface to `BrainstrikeToolSearchProcessor` (the fail-loud wrapper around
Mastra 1.51 `ToolSearchProcessor`). Built-in/local runtime behavior is unchanged;
provider-native tool-search adapters remain out of scope.

The canonical native metadata has one exact eight-tool `critical` set:
`askUser`, `executeCommand`, `globWorkspace`, `grepSearch`,
`readWorkspaceFile`, `stringReplaceWorkspaceFile`, `submitPlan`, and
`writeWorkspaceFile`. These are the universal exact-read/search/edit/create/
execute/suspend primitives that remain model-visible after discovery goes
live. Keeping one approval-gated create primitive critical is deliberate:
smaller hosted models otherwise cannot create a new file unless they first
infer that they must search for the deferred write tool. The search/load
control is owned by the selected discovery adapter and must be exposed beside
this set; it is not a second Brainstrike native-tool id. Every other native tool is `deferred` and
belongs to exactly one concise namespace in
`NATIVE_TOOL_DISCOVERY_NAMESPACES`: artifacts, context, embeddings, semantics,
sessions, skills, web, or specialist workspace operations. Namespace parity tests prove
that the critical plus deferred partitions cover every canonical native id
exactly once and that no namespace exceeds nine functions.

Loading tier is not authorization. User-enabled means only eligible for
discovery. `resolveToolDiscoveryPhaseAccess` keeps disabled, permission-denied,
and host-unavailable tools out of search, load, and active phases. An `ask`
permission remains searchable/loadable, but the existing downstream permission
gate must still suspend before execution. A loaded bit is required before an
eligible deferred tool becomes active. Runtime partitioning happens only after
guards, hooks, plan mode, permission, approval-storage, provider web-search,
artifact settlement, and model-output projection; it cannot restore a tool any
earlier stage omitted. Unknown caller-supplied local tools remain eager because
Brainstrike has no authoritative loading metadata for them. Existing
provider-defined web search remains eager because its provider-owned id/type
pair is not a normal function definition that catalog search may rename.
Mastra's canonical `skill`, `skill_read`, and `skill_search` controls also stay
eager: `SkillsProcessor` tells the model to call them directly, so deferring
them would make Mastra's own injected instructions reference unavailable tools.
The eligible `readToolOutputArtifact` recovery control stays eager for the same
reason: settlement emits directly callable continuation actions. This adds no
alias and does not bypass eligibility or permission gates.

`LlmModelDefinition.nativeToolSearch` records provider-native support on the
exact model route:

- Direct OpenAI GPT-5.4 and newer routes declare `openai`; older GPT-5.x routes
  do not. OpenRouter aliases do not inherit the capability because the gateway
  route is a different adapter.
- Current supported direct Anthropic models declare `anthropic`.
- Other declared hosted/gateway LLMs resolve to Mastra catalog search.
- The built-in browser-local model resolves explicitly to `eager-core-only`;
  this contract does not alter its current runtime. Dynamically discovered
  Ollama/LM Studio model ids resolve `unsupported` until their authoritative
  catalog exposes a tool-search capability signal.
- Unknown static model ids and non-LLM providers resolve `unsupported` for
  automatic or provider-native selection. An explicitly requested
  `mastra-catalog-search` adapter is runtime-based: a hosted LLM supplied through
  the supported model-override seam remains valid even when its model id is not
  in the static catalog. Browser-local and non-LLM providers remain unsupported.

`resolveToolDiscoveryAdapter` never substitutes another strategy when a caller
requests an adapter the exact route does not support. The unsupported result
retains a typed reason, keeping an adapter mismatch distinct from a catalog miss,
permission denial, and host unavailability. OpenAI's native `tool_search` is
model-gated, not inferred from `provider === "openai"`. Anthropic native search
likewise preserves provider search/tool-reference history. Live Mastra catalog
search uses `storage: 'context'` and `search: { autoLoad: false, topK: 3 }` —
Mastra's manual-loading mode (BST-1667). `search_tools` is discovery only: it
returns at most three ranked matches and loads nothing. `load_tool` is Mastra's
canonical exact-name selection (`toolName` or `toolNames[]`, "Did you mean"
suggestions on a miss, the same SDK search filter and context-store
activation) and loads exactly the named tools. Every discovery step offers, in
this key order: `search_tools`, `load_tool`, the loaded deferred tools, then
`list_available_tools`. Model-facing flow: exact name known (instructions,
catalog, skill activation) → `load_tool` → call; capability only →
`search_tools` → `load_tool` → call. The trade-off is deliberate and stated
honestly: fuzzy discovery now costs one extra model step versus the retired
auto-load, while an exact load costs the same step it always did and loads one
tool. Do not re-enable `search.autoLoad: true`: per Mastra's own option docs
that mode withholds `load_tool`, and the BST-1628 workaround — a pnpm patch on
`@mastra/core@1.59.0` splicing exact-name selection into `search_tools`' BM25
path — was a misuse of the search control, not a missing upstream feature.
That patch and its `patchedDependencies` entry are deleted; the repo carries
zero pnpm patches again.
Search results are ranked selections, never an inventory. The 2026-09-04
Linear failure had all 61 tools in the eligible deferred catalog, but a broad
query returned three label/status tools and the model declared issue operations
unavailable. `list_available_tools` therefore exposes the same post-gate,
per-runtime deferred catalog without loading definitions or executing MCP requests.
It supports case-insensitive name prefixes and pages of 50 entries, reports
the matching total and `nextOffset` (null only at the end), and explicitly
marks descriptions shortened to 160 Unicode code points. Eager tools are already
callable and are not included in this deferred inventory. Ordering uses code-unit name
comparison rather than the host locale. Each prefix/offset query is independent;
clients must keep the prefix when following nextOffset. An offset exactly at
the matching count returns the empty end page; an offset beyond it reports a typed pagination error with the offset and matching count.
The name map is total for eligible tools and snapshotted per processor; missing
mappings fail visibly at construction or loaded-tool projection.
Models enumerate with it and
load a capability with `load_tool` using an exact listed name. Inventory
results never enter Mastra's loaded-tool state; search results and instructions
explicitly distinguish ranked matches from the complete catalog. No new store,
remote round trip, or eligibility path is introduced. Processor tests cover
61-tool pagination, runtime isolation, and selective loading; the real Mastra
loop test covers inventory -> search -> execution.

Mastra's BM25 catalog ranks the sanitized tool id plus its canonical
description. Brainstrike's initial `search_tools` description must therefore
name the major deferred capability families explicitly, including open
workspace roots and focused context. Aside from the deliberately critical
create primitive above, do not widen the eager registry to work around a model
that skips discovery. Deterministic ranking fixtures cover the
context/list/read/grep/glob/edit/command intents. The opt-in hosted matrix in
`tool-discovery-live-eval.integration.spec.ts` exercises GPT-5.4 Mini and Claude
Haiku against the real processor and fails visibly when either provider key is
absent.

Hosted default instructions add the discovery guidance only when the runtime
actually installs `BrainstrikeToolSearchProcessor`. They tell the model to load
deferred capability families — `load_tool` by exact name, or `search_tools`
then `load_tool` — before substituting eager glob or shell tools.

**THE DISCOVERY SURFACES NAME EVERY ELIGIBLE DEFERRED FAMILY — AND ONLY
ELIGIBLE ONES.** A deferred capability the prompt never names is a tool the
model declares nonexistent instead of searching for: the 2026-08-23 field
failure dismissed both "the canvas tool" (`manageCanvas`) and a skill
activation's named `runSkillScript` as missing, and worked around the latter
via `executeCommand` — bypassing the typed skill-script policy layer. The
opposite failure is advertising a family the run cannot load (a WEB run's
eligible set excludes canvas/Python/browsers/command sessions/diagnostics/
self-query/skill scripts). Both surfaces — the instructions' discovery line
AND `search_tools`' own tool description — therefore DERIVE their family list
per run from `deferred-capability-families.ts`, the single source; the
`tool-discovery capability coverage` spec pins that every runtime-deferred
native tool (`loadingTier !== 'critical'`, skill ids force-cored) belongs to
a family, that eligible families are named, and that ineligible ones are not.
The line also states that a tool NAMED by the instructions or a skill
activation but not loaded is reachable via `load_tool` by exact name — the prompt names
tools by exact id (`toolNameMap` spans both surfaces) that are not in the
model's callable list until discovered, and without that sentence the model
resolves the contradiction the wrong way.
`BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE` (appended to every skill activation
result, with its space RESERVED inside the activation budget so truncation
can never slice it off) carries the same recovery clause for
`runSkillScript`, self-gated on `load_tool` being available.

**"NEXT TURN" MEANS THE NEXT MODEL STEP OF THE SAME RESPONSE — say so
explicitly.** Mastra's loading copy says a loaded tool is "available on your
next turn" (under the retired auto-load it was `search_tools`' system line,
description, and result; under manual loading it is `load_tool`'s success
result). In chat vocabulary a turn is a user message. The 2026-09-02 live
Linear write proof failed on exactly that reading: `search_tools` (then
auto-loading) loaded
`linear.save_issue`, the loaded definition was in the very next step
(`mastra_tool_discovery_step` reported it), and the model still ended its
reply with "I'll create the Linear issue once the ticket integration finishes
loading" — `finishReason: stop`, no `tools/call` ever sent, so the owner saw a
chat that "stopped after the tool call" with no error anywhere. No runtime
layer was involved. Every Brainstrike-owned surface therefore says "callable
on your next step in this same response" and forbids ending the reply to
wait: the instructions' discovery line pins the meaning of "next turn", the
`search_tools` result (`describeSearchMatches`, ranked list untouched) says
matches are not loaded yet and to call `load_tool` with the exact name, the
skill execution guidance says the same, and `wrapLoadTool` rewrites Mastra's
`load_tool` success sentence (`describeLoadResult`) while leaving its failure
copy — not found, "Did you mean" — verbatim, since there is nothing to call.
Mastra's injected system line is the one surface Brainstrike does not own; in
manual mode it says only that tools must be loaded before use, and the
instructions' definition is what neutralizes any "next turn" reading. Pinned by
`default-instructions.spec.ts`, `tool-search-runtime.spec.ts`, and
`skill-tools.spec.ts`.

**THE BATCHING EXEMPTION LIVES ON THE BATCHING LINE — do not relitigate.** A
loaded tool is callable only on the FOLLOWING model step, so batching `search_tools`
or `load_tool` with slow calls strands the discovery for their whole duration: an observed run
issued it alongside two delegations that took ~15 minutes each, then spent three
`search_tools` calls locating one tool the user had named explicitly. The
exemption is therefore carried by `buildParallelCallInstruction`, NOT only by
the discovery line ~15 instructions away — "Batch independent reads, searches,
or commands into one turn" is the plausible proximate cause, since a model
scanning for permission to batch reads "searches" as covering `search_tools`,
and a caveat it has to go looking for is one it will not apply. It is
CONDITIONAL on discovery being installed, so a run without it is never told
about a tool it does not have. Stated once: repeating it on the discovery line
spends prompt budget saying the same thing.

Making a loaded tool callable on the step after `load_tool` is Mastra's tool-search
contract, not ours; the ordering advice is the half Brainstrike owns. The live matrix passes that processor through Mastra
`runEvals.targetOptions`: Brainstrike owns input processors at the per-call
stream seam, so targeting the bare Agent without those options is not a valid
discovery evaluation.

Discovery observability is content-minimizing by default. Production logs may
record query length plus the original ranked tool ids and finite scores, but
never the raw query, tool schemas, or credentials. The exact query is available
only to an explicit in-memory observer used by the opt-in live evaluation; it
is neither logged nor persisted. The live evaluation also records the final
tool choice and scorer verdict so a retrieval success cannot be mistaken for a
successful model decision.

The telemetry wrapper clones Mastra's `search_tools` value with its original
prototype and complete own-property descriptors, then replaces only the
description and executor on that fresh clone. It never mutates or wraps the
Mastra-owned value in place. Mastra 1.51 context storage is also pinned as
empty-or-complete for approval resume: its same-process supplemental set is
additive by thread, while live message-derived names are unioned with that set.
The adapter compatibility test loads two disjoint tools and requires the direct
resume lookup to return both without durable recall. If a future Mastra release
permits a partial non-empty set, update the adapter to merge the post-gate
durable and delegate sets deterministically; do not add a speculative fallback.

Mastra owns the fixed `search_tools` and `load_tool` catalog meta-tool ids;
Brainstrike owns `list_available_tools`. When a surviving
eager/core or deferred definition has an original id whose canonical sanitized
form is any of the three reserved ids (including `search.tools`, `load.tool`,
and `list.available.tools`), a run with deferred catalog
discovery throws `mastra_agent_tool_name_collision` before constructing the
Agent. The error reports only the original, sanitized, and reserved ids. A run
with no deferred definitions installs no catalog processor and preserves a
caller-owned `search_tools` or `load_tool`; never rename the collision, disable
discovery, or widen the eager surface silently.
`load_tool` joined the reserved set in BST-1667 when discovery moved to manual
loading (`search.autoLoad: false`); `MASTRA_CATALOG_META_TOOL_IDS` in
`runtime-assembly/tool-pipeline.ts` is the single list, and the compatibility
tests cover all three ids.
Persisted `load_tool` results (and legacy auto-load `search_tools` results on
threads recorded before BST-1667) reconstruct loaded definitions after restart;
approval and suspended-tool resume rehydrate those definitions from the durable
Mastra thread before the paused call reaches execution. Anonymous calls never
share a default store. A loaded-set shrink within one runtime/thread (for
example, trimming away its discovery result) throws the typed
`mastra_agent_tool_discovery_failure` instead of silently de-loading.
`TOOL_DISCOVERY_FAILURE_CODES` pins the distinct
failure channels as `catalog-miss`, `permission-denied`, `host-unavailable`, and
`unsupported-adapter`; adapters must not collapse them into an empty result.

#### Provider-native decisions (BST-614 and BST-680, 2026-07-21)

Provider-native support is declarative, not live. The measured decision remains
`mastra-catalog-search` for every hosted production route:

- OpenAI GPT-5.4 Mini and GPT-5.6 Luna both reached native hosted search, then
  failed on the second request because the AI SDK serialized the same stored
  `tool_search_output` item reference twice. OpenAI rejected the request as a
  duplicate item. The latest available OpenAI adapter source retained the same
  branch, so a version bump is not an accepted fix without a captured-request
  regression.
- Anthropic Claude Sonnet 4.6 preserved deferred definitions, approval
  suspension, execution, and approval resume. It missed the target tool from a
  normal task prompt, however, and succeeded only when instructed to issue a
  search query matching the tool description. That successful run had no
  material token/cost advantage over the Mastra baseline.
- The identical Mastra catalog scenario selected and executed the target on all
  three models. Do not trade this quality floor for a smaller unsuccessful
  request or a one-turn improvement that needs answer-specific prompting.

BST-680 subsequently removed OpenAI's duplicate-item blocker without a patched
dependency. Live GPT-5.4 Mini and GPT-5.6 Luna native runs then selected and
executed both semantic and exact-path targets with distinct `tsc_...` and
`tso_...` references. Production adoption still failed its paired economic
gate: compared with the same Mastra catalog, native used 69–117% more input
tokens and cost an estimated 36–79% more across all four comparisons. It was
also slower on both GPT-5.4 Mini scenarios; Luna's isolated exact-path latency
win was not a consistent cross-model advantage. The broader paid matrix stopped
at that failed gate. The full measurements and revisit condition are in
`docs/agents/research/bst-680-openai-native-tool-search-requalification.md`.

There is no fallback between discovery adapters. A future provider-native slice
must be selected explicitly and independently prove provider-history
serialization, normal-prompt selection/miss quality, post-policy catalog
admission, MCP/provider-web coexistence, approval suspension, durable restart
resume, cache behavior, and non-inferior token/cost measurements. The complete
evidence and live tables are in
`docs/agents/research/bst-614-native-tool-search-spike.md` and
`docs/agents/research/bst-680-openai-native-tool-search-requalification.md`.

#### Programmatic orchestration decision (BST-616, 2026-07-21)

Do not add a production programmatic-orchestration mode yet. GPT-5.6 Luna's
hosted Programmatic Tool Calling cut input tokens by 71–94% and estimated cost
by 56–89% on three bounded fan-out workloads, but it was strictly correct on
only one of three first runs; direct calling passed all three. The installed
Mastra 1.51.0 / AI SDK OpenAI 4.0.8 path also cannot express the hosted tool,
`allowed_callers`, function `output_schema`, nested `caller`, or `program` /
`program_output` continuation items. Do not add casts or a raw parallel
Responses loop around Mastra's provider-history, persistence, suspension,
telemetry, and processor contracts.

**Adapter-gap update (BST-1284, 2026-08-15).** The adapter half of that second
sentence is now stale: `@ai-sdk/openai` 4.0.42 ships
`openai.tools.programmaticToolCalling()` (`openai.programmatic_tool_calling`,
provider-executed) plus `allowedCallers`, function `outputSchema`, nested
`caller`, and `program` / `program_output` continuation items — all five
recorded gaps have closed, and
`provider-native-programmatic-tool-calling-compat.spec.ts` now pins that
surface. **The no-go itself stands.** Its other ground is the measured
correctness result (strictly correct on one of three first runs, against three
of three for direct calling), which a dependency bump cannot move. Adoption
still requires a fresh measured re-run against the gates recorded above; the
version bump deliberately did not adopt it.

OpenCode Code Mode validates the local architecture shape: a confined
interpreter over a permission-filtered catalog can reduce fixed read-only
programs without ambient filesystem, process, network, or module authority.
Its host must still reauthorize every nested call and set explicit timeout,
call-count, concurrency, and output budgets. The measured fixed programs were
correct and kept 98–99% of raw intermediate characters out of their final
results, but they were hand-authored and therefore do not establish
model-authored-program quality.

If upstream support and model quality later clear the recorded gates, the exact
program-visible candidate allowlist is `readWorkspaceFile`,
`readWorkspaceDirectory`, `globWorkspace`, `grepSearch`, and
`findWorkspaceSymbol`, intersected after capability, user-enabled, and
permission admission. Keep semantic/adaptive retrieval, web/citation work,
artifact continuation, MCP discovery, LSP diagnostics, command sessions,
shell, approvals, writes, task/plan state, external actions, and unknown tools
direct. There is no silent route switch. Full evidence is in
`docs/agents/research/bst-616-programmatic-orchestration-spike.md`.

The live assembly order is pinned by `TOOL_DISCOVERY_PIPELINE_ORDER`:
capability/permission eligibility → guards/hooks → plan/permission/suspend gates
→ provider-native web-search swap → output settlement/projection → skills
metadata → discovery → projection-safe stale-history filtering →
provider-history compatibility → projection-aware token limiting. Initial,
approval-resume, and suspend-resume
calls all use the same per-runtime processors in the per-call input stack:
SkillsProcessor → tool search → ProjectionSafeToolCallFilter →
ToolProjectionRewrite → ProviderHistoryCompat → OpenAI tool-search history
compatibility → OpenAI duplicate-item compatibility →
ProjectionAwareTokenLimiter. Token limiting remains last so it counts injected
skills metadata, loaded definitions, filtered/rewritten tool history, and
normalized provider history. Public direct stream processor overrides stay
rejected.

The full hosted desktop tool surface has two measured prompt budgets:
`apps/desktop/src/__tests__/assistant-server/native-tool-prompt-budget.test.ts`
builds the real registry and resolved hosted instructions with the default
skills engine enabled. That means both guards include `skill`, `skill_read`,
and `skill_search`, the conditional skills guidance, and a representative
first-turn `SkillsProcessor` metadata block. The canonical authored
representation converts the real Zod inputs through the Standard Schema input
protocol and must stay INSIDE the 10,096-10,396 `o200k_base` band (BST-927/
BST-980): the ceiling bounds growth, and the floor detects a tool or schema
silently falling out of the registry. These are existing test thresholds, not
bands recentered by the audit. At the 2026-09-04 measurement, authored and critical
surfaces have only 34 and 21 tokens of remaining headroom. Keeping those ceilings
is deliberate pending BST-1633's measured reductions; the audit does not promise
150 tokens of current headroom or silently raise limits to absorb drift. When
the ceiling fires, trim before raising; move both bounds
together (the ~300-token width is the contract) and record the trade in the
test's comment ledger. The live actual Mastra/OpenRouter core surface and
resolved instructions must stay between 2,000 and 5,000 tokens, materially
below the retired 11,500-token eager boundary. A real
Mastra-loop capture separately proves the first provider request contains that
core plus `search_tools`, `load_tool`, and `list_available_tools`, and that a later request appends the
definition loaded by `load_tool`. Dynamically loaded definitions are append-only within the active
context and counted by the last-position token limiter.

Both count schemas and instructions for their declared surfaces, not descriptions
alone. The core envelope excludes processor-added discovery controls. The
2026-09-04 probe measured 4,730 tokens before those controls and 5,081 with them
in the same normalized representation. BST-1633 tracks the complete post-processor
provider budget and total tokens per successful task; the existing core ceiling
must not be presented as a cap on the full request. Tokenizer counts are not
provider-billed usage or a cache-discount estimate.
Recover budget by removing duplicated prose and preserving one canonical
definition. Do not weaken validation constraints, spoof provider/model
identity, or remove cross-tool safety/workspace invariants to make either
number pass. Changing Mastra compatibility behavior requires a supported
upstream contract plus captured-request tests proving omitted optionals and
invalid/null inputs retain their authored semantics.

The same fixture also pins the authored definition-only comparison for this
contract: the eager baseline is 39 tools, measured at 9,490 `o200k_base` tokens
on 2026-09-04, within its 9,340-9,640 band. The live critical definition surface
is 8 tools, measured at 2,295 tokens within its 2,016-2,316 band, before discovery
controls are added. Counts stay exact to catch missing tools; no budget was
raised during the BST-1630 audit. System instructions, provider conversion,
skills metadata, and each dynamically loaded definition remain part of the
captured-request and last-position limiter budgets.

Persistent commands use two deferred model tools, not six operation-specific
definitions: `inspectCommandSessions` owns read-risk list/read, while
`manageCommandSession` owns execute-risk start/write/stop/remove. Each schema is
a provider-compatible root object containing a nested discriminated `operation`
union. This prevents models from filling irrelevant action fields while keeping
the critical request unchanged; together the two deferred definitions add 809
tokens to the pre-session eager baseline. A single mixed-risk tool is forbidden
because it would either hide harmless inspection behind execute approval or expose
process control as read; top-level schema unions are forbidden because hosted
providers require a root object. Plan mode keeps inspection and omits
management. Inventory pages continue with `offset`, and PTY reads continue with
the exact returned `nextCursor`; both raw result shapes stay below a 5,500-byte
UTF-8 producer ceiling. Their canonical ids are also explicitly excluded from
durable artifact settlement so a hook envelope cannot create a seven-day copy.
Target-aware transcript transforms retain safe action, session, cursor, and
length metadata but redact command strings, cwd, stdin, input deltas, PTY
output, and guarded error messages/reasons before persistence. The built-in local
provider gets neither definition because it has no deferred-discovery path and
would otherwise pay both schemas eagerly.
Desktop registers the capability; Web has no desktop registry, uses the explicit
`WEB_NATIVE_TOOL_IDS` UI/request partition, and therefore exposes neither tool.

The desktop Terminal surface exposes those process-owned sessions through the
capability-gated `window.commandSessions` bridge. Its list/read/write/stop/remove
operations always include the durable workspace root id; the manager rejects a
session owned by another root with the same not-found error. Reads are paged at
32,768 UTF-16 code units with an advancing absolute cursor, explicit `hasMore`,
and the manager's gap/truncation signal. The manager applies that limit while
decoding retained blocks, before joining the page, and never splits a surrogate
pair. IPC retains a fail-loud 32,768-unit assertion; it never materializes and
then silently trims a larger manager result. The same manager-side page bound
applies to the model inspection tool. The renderer retains at most 128 KiB of
visible output. This bridge does not add a second process registry, persist the
command/cwd/environment/output, or exist on Web. Because the manager lives in
Electron main, the inventory reattaches after a renderer reload while normal
shutdown, factory reset, and root removal still reap it through the existing
lifecycle.

---
