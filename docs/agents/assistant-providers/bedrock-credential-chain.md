# Bedrock credential chain — evidence

Supports `docs/agents/assistant-providers.md` § "Amazon Bedrock". DB catalog enablement, the credential projection capability, the chain module, and its measured failure classifier.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 1743-1830); append rather than
rewrite.

---

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
