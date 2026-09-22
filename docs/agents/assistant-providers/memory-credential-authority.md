# Provider-backed memory credential authority — evidence

Supports `docs/agents/assistant-providers.md` § "AI ASSISTANT INTEGRATION". Observational memory and semantic recall resolve through the same env/keychain chain as the request.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 319-356); append rather than
rewrite.

---

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
