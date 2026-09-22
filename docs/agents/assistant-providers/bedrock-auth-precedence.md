# Bedrock auth precedence and region rules — evidence

Supports `docs/agents/assistant-providers.md` § "Amazon Bedrock". The four-rung precedence table, the env-chain activation rule, and the region rules.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 1564-1652); append rather than
rewrite.

---

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
