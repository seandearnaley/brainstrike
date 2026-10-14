# Provider credential seam — evidence

Supports `docs/agents/assistant-providers.md` § "Provider credential seam". Reader types, the string migration shim, the factory auth input union, and the threading rule.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 1335-1476); append rather than
rewrite.

---

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
