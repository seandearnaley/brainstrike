# Credential-verification probes — evidence

Supports `docs/agents/assistant-providers.md` § "Credential-verification probes". The probe table, the status semantics, and the profile-chain probe.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 1480-1560); append rather than
rewrite.

---

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
