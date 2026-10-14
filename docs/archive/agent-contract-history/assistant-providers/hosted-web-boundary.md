# Hosted Web request trust boundary — evidence

Supports `docs/agents/assistant-providers.md` § "AI ASSISTANT INTEGRATION". The Hosted Web key policy, the converged decision core, the request envelope, and its bounds.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 357-520); append rather than
rewrite.

---

  - Hosted Web: local Vite and protected Vercel Preview may read server-only
    OpenAI, Anthropic, Google, and OpenRouter environment keys using each
    provider registry entry's canonical precedence. Whitespace-only values are
    unconfigured. Status advertises configured provider IDs and exact safe
    environment-key sources, never values; each advertised provider is fixed to
    its registry default model in the renderer. A request may select only one of
    that configured set. Unknown, non-Hosted-Web, and credential-less providers
    fail as `invalid_runtime_data` / HTTP 400 rather than falling back to another
    key. The server injects the selected provider's key and ignores client
    model/key/base-URL attempts. Because the Vite process holds developer
    credentials, its assistant
    middleware has an explicit LOCAL request boundary before status, body
    parsing, or stream dispatch: the TCP peer must be IPv4/IPv6 loopback, the
    `Host` must be exactly `localhost` or a loopback IP authority, and browser
    `Origin` / Fetch Metadata must be same-origin. A loopback CLI request with no
    `Origin` remains supported. Assistant POSTs additionally require
    `Content-Type: application/json`; remote clients, DNS-rebinding hosts,
    cross-origin browsers, and non-JSON media types receive stable typed
    403/415 errors while their request stream is drained. Do not weaken that
    application boundary merely because Vite also has listener/allowed-host
    controls. The deployable Vercel entrypoints enable that key only when
    `VERCEL_ENV=preview`; missing, development, production, and unknown values
    fail closed as `production_auth_required`. Production enablement requires
    application authentication plus distributed quota/cost controls. Never
    expose a key through a `VITE_`-prefixed variable. The web package declares
    native ESM so Vercel selects ESM library exports without relying on its
    disabled `require(ESM)` feature. API-relative imports use explicit `.js`
    extensions under the Node16 type check; built and deployed status/POST
    routes must be exercised when changing this module boundary. The shared renderer's
    model, generation, loop, MCP, and enabled-tool fields are wire-compatibility
    hints only and are never copied into that trusted runtime. The provider field
    is the sole exception: it is copied only after exact membership validation
    against the server-configured Hosted Web provider set — and since the
    BST-973-2 convergence it is REQUIRED on assistant turns. Both Hosted Web
    transports (the Vercel function and the Vite dev/preview middleware) run one
    converged decision core (`runWebAssistantPost` in
    `apps/web/src/server/web-assistant-post.ts`, which passes the allow-list
    `filterWebAssistantPayload` as the SHARED `prepareAssistantPostRequest`'s
    `filterPayload` hook — BST-1030). The hook's ORDERING is a contract, pinned
    by tests in `packages/assistant-service/src/__tests__/request.test.ts`: it
    runs on the parsed envelope AFTER `parseAssistantRequestPayloadText` and
    BEFORE tool-continuation extraction and native-tool-id validation, so what
    the filter strips can never reach validation, and the hook's own typed
    errors propagate OUT of preparation to the transport-owned mapping (they
    are never mapped inside the package). A refactor that moves or bypasses
    this hook moves web's trust boundary — update the tests and this section
    together. With the hook in place, a
    request that names no `data.provider` is rejected `missing_provider` /
    HTTP 400 exactly like desktop — the old web-only default-provider fallback
    is gone, and the 503 server-config gate precedes request validation. Do not
    reintroduce a fallback in either transport; the shared renderer always
    names its provider.
    `resolveWebAssistantRuntime` (still the chat endpoint's boundary) and the
    assistant pre-filter copy an explicit allowlist of non-privileged
    request metadata only after strict runtime validation of every value,
    including bounded strings, arrays, numbers, and strict nested objects.
    Malformed known fields and server-only, capability-inapplicable, or unknown
    fields (including `apiKey`, `mcpConfig`, `mastraTools`, `permissionPolicy`,
    and `permissionPolicyRequest`) fail with
    `invalid_runtime_data` / HTTP 400. TypeScript types alone are not a request
    trust boundary. The Web request therefore cannot create tools, launch stdio
    MCP, replace provider credentials, or set server cost policy through
    serialized runtime data. Hosted Web has an explicit 4 MiB serialized
    request-body capability, below Vercel Functions' non-configurable 4.5 MB
    ingress ceiling. App-shell passes that capability only when the desktop
    assistant bridge is absent, and the shared renderer measures the exact
    UTF-8 JSON body before `fetch`, so normal Web UI turns fail visibly before
    the platform can substitute its generic `FUNCTION_PAYLOAD_TOO_LARGE`
    response. The Vercel Function handler and Vite dev/preview middleware
    enforce the same 4 MiB maximum before JSON parsing;
    `BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES` accepts only a positive
    safe integer and may lower that server cap but never raise it. Declared and
    streamed/chunked overflow is byte-counted
    and fails with `request_body_too_large` / HTTP 413 while the Node stream
    drains. A direct Vercel request above the platform's 4.5 MB limit can still
    be rejected before Brainstrike code runs. Desktop retains the canonical
    16 MiB server limit. Restoring larger inline-image turns on deployable Web
    requires direct blob/object-storage uploads instead of routing base64
    through the Function. Malformed JSON fails without logging its value as
    `invalid_json` / HTTP 400; an empty or whitespace-only body is malformed
    JSON rather than an implicit empty request. The canonical assistant request
    envelope has exactly four possible top-level fields: required `messages`
    plus optional `data`, `runConfig`, and `unstable_assistantMessageId`.
    `messages` must be an own array (an empty array is valid for approval and
    suspend/resume action legs), while present `data` and `runConfig` must be
    objects. Missing `messages`, non-object roots, invalid optional objects, and
    every unknown top-level field fail as `invalid_request_payload` / HTTP 400
    on Vercel Preview, Vite dev/preview, and Desktop. The renderer constructs that exact
    shape through the shared assistant-contract helper. It omits assistant-ui
    thread/parent bookkeeping because the message graph and `data.memory` own
    topology, and rejects non-empty client `callSettings`, `config`, `system`,
    `tools`, or message state before fetch because the custom server consumes
    none of them. In particular, provider API keys/base URLs and per-call
    headers can never leak through assistant-ui's generic model-context bags.
    `runConfig` is bounded by the active transport cap (4 MiB Web, 16 MiB
    Desktop); only the shared approval/suspend action readers consume it, and a
    suspend action's `resumeData` is then validated by the tool's Mastra resume
    schema. Do not
    forward any other `runConfig` subtree: expanding that contract first
    requires shared graph, identifier, and UI-input bounds.
    This envelope reduces and secures HTTP transport bytes; model-context
    savings remain the separate memory/projection/compaction contracts below.
    Before recursive assistant-ui compatibility normalization, the shared
    iterative message boundary caps message and part counts, graph nodes/depth,
    object fields, and string sizes. It rejects
    cycles, non-plain objects, and non-JSON scalars (including bigint and
    non-finite numbers) while permitting `undefined` for optional in-memory
    fields. Violations fail as `invalid_messages` / HTTP 400. Message conversion
    is role-, part-, and path-aware: it reads only root compatibility text and
    direct `content`/`parts` text fields, and recognizes attachments only as
    direct file parts on user messages. Tool calls, tool results, data parts, and
    their nested domain payloads remain opaque, so a workspace entry such as
    `{type:"file",path:"README.md"}` can never collide with the attachment
    discriminator or be flattened into prompt text. The elevated data-URL string
    allowance likewise applies only at those exact user-file positions; every
    other string remains under the normal graph budget. An image attachment is
    prompt content in its own right, so validated
    image-only user turns are accepted consistently by Vercel Preview, local
    Vite, and Desktop.
    Blank text-only turns and turns ending in assistant/system history remain
    invalid. Prompt validity is checked against the FINAL raw wire entry before
    lossy compatibility normalization, never against the last surviving history
    message; a dropped blank/tool-only tail therefore cannot replay an earlier
    user prompt. Attachment limits count wire occurrences rather than object
    identity. File parts require canonical
    base64 alphabet, length, and padding, and the data-URL media type must equal
    the declared allowlisted image media type. An empty base64 body is invalid
    (`invalid-base64`), never a canonical zero-byte image. Malformed direct file
    parts and attachment validation failures return a safe `invalid_attachment`
    / HTTP 400 response across Vercel Preview, Vite dev/preview, and Desktop.
    Approval resume actions
    likewise cross a strict shared boundary: only the exact `action`, `runId`,
    `toolCallId`, and optional
    `toolName` own keys are accepted; identifiers must be non-empty and stay
    within the documented 512-character transport ceilings. Extra keys and
    oversized identifiers return `invalid_tool_approval_action` / HTTP 400 on
    both Vercel Preview and Vite dev/preview routes. Suspend-resume actions use
    the same exact-own-key and 512-character identifier bounds; extra keys,
    inherited fields, blank tool names, and oversized identifiers return
    `invalid_tool_resume_action` / HTTP 400. After normalization, chat requests
    require at least one effective message and normal assistant turns require a
    non-empty prompt on both Vercel Preview and Vite dev/preview routes. Hosted
    Web has no durable workflow or stream-replay store. Both Vercel Preview and
    Vite dev/preview therefore reject valid approval and suspend-resume
    actions with typed HTTP 409 responses, and reject every non-empty
    `Last-Event-ID` as `stream_resume_unavailable` instead of depending on lucky
    process affinity. These requests still consume the bounded body first, so a
    reconnect cannot bypass the cap. Normal turns call the shared stateless Web
    stream builder without a Mastra storage argument and create a single
    non-registering data-stream response. They never enter the desktop
    process-local replay map or retain encoded output for its two-minute replay
    window.
    Wire-compatible provider/model/tool hints are strictly bounded and validated
    before they are discarded, including iterative
    depth/cardinality/string/number limits for arbitrary provider options. The
    UI's `transportImageElision` observability metadata follows the same rule:
    Web accepts only the bounded, strict shared-contract shape and discards it
    before building the trusted model runtime.
    The Vite deployment declares real root `api/assistant.ts` and
    `api/assistant/status.ts` Vercel Function entrypoints; `src/app/api/**`
    alone is not discoverable in a static Vite project. Those wrappers enforce
    the protected-preview-only deployment boundary before delegating. The
    legacy `/api/chat` handler remains dev-only because its process-local rate
    limiter cannot enforce a production limit across function instances.
