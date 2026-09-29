# Typed provider credentials in the keychain — evidence

Supports `docs/agents/assistant-providers.md` § "AI ASSISTANT INTEGRATION". The stored-credential envelope, the legacy bare-string mapping, and the secrets IPC contract.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 139-218); append rather than
rewrite.

---

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
