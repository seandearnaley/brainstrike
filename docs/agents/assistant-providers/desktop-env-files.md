# Desktop environment files and canonical env names — evidence

Supports `docs/agents/assistant-providers.md` § "AI ASSISTANT INTEGRATION". Env-file loading, the canonical/deprecated name tables, and the child-env scrub.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 219-305); append rather than
rewrite.

---

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
