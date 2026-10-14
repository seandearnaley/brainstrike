# OpenAI Codex subscription provider — evidence

Supports `docs/agents/assistant-providers.md` § "OpenAI Codex — ChatGPT subscription provider". The descriptor, the `codex/` prefix, the fetch closure, and assistant-token origin tracking.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 1975-2039); append rather than
rewrite.

---

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
