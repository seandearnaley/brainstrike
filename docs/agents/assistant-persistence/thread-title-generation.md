# Automatic thread titles — evidence

Supports `docs/agents/assistant-persistence.md` §
"ASSISTANT THREAD PERSISTENCE & RELOAD HYDRATION". Read this before proposing to change the title lifecycle, its rollback semantics, or the live title projection.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Automatic thread titles use Mastra Memory's top-level `generateTitle: true`
option and `Agent.generateTitleFromUserMessage`. At the terminal Mastra finish,
the stream adapter starts that canonical title request with the active agent
model before yielding the UI finish, then keeps the per-run Mastra instance
alive for one bounded 30-second title lifecycle. The title model receives the
active request's provider options and output-token cap; OpenRouter retries one
text-empty result on that same model, never a fallback provider. Expiry aborts
the underlying model call and marks the transactional PGlite save for rollback,
rather than merely detaching either operation. Provider, invalid-output,
configuration, persistence-read, and persistence-write failures are logged with
stage-specific privacy-safe metadata while the successful main response remains
intact. Generation remains independent of Observational Memory, its token
threshold, and whether OM is thread- or resource-scoped. The generated title is
persisted through `PgliteMemoryStore.saveThread`; that transactional boundary
may replace only an empty/default/system-owned title and stamps `titleSource:
'om'`, while the manual rename path clears the marker and always wins even if
generation was already in flight. Title generation deliberately does not delay
the main assistant response, so provider `message-finish` is not a reliable
primary title-refresh signal. App-shell live-subscribes to the local
`mastra_threads` id/title projection and re-lists the loaded resource only when
that stable projection changes. This makes background titles visible in thread
rows and tabs without a timer or an API round trip. The existing
`message-finish` refresh remains intentionally separate: once per completed
turn it updates thread recency, ordering, and latest-run details, and provides
a best-effort recovery path if the live subscription has failed.

Loaded resource thread lists enforce latest-successful-start ordering per
resource without timers. Every refresh receives a generation from that
resource's map entry. A non-empty successful result applies unless a
later-started successful result has already applied; a newer empty result or
rejected read does not suppress an older successful result. Empty-result and
stale-generation checks remain separate because they encode different
contracts. `resetAssistantThreadStore` clears the generation map, and each
in-flight refresh also retains its map-entry identity, so a result from before
reset cannot publish into the reset store even if a new resource refresh later
reuses the same numeric generation. The gated-promise regressions live in
`packages/assistant-data/src/__tests__/assistant-thread-store.test.ts`.

