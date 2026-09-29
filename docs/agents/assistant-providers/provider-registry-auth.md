# Provider registry auth metadata — evidence

Supports `docs/agents/assistant-providers.md` § "Provider registry auth metadata". What derives from `authType`, and the known remaining hand-sites.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 1264-1331); append rather than
rewrite.

---

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
