# Credential Inventory — evidence

Supports `docs/agents/assistant-providers.md` § "AI ASSISTANT INTEGRATION". The Settings credential surface: one row per slot, the aws two-mode editor, and the fingerprint rules.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 98-138); append rather than
rewrite.

---

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
