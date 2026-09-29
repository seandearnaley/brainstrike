# Assistant status and provider discovery — evidence

Supports `docs/agents/assistant-providers.md` § "AI ASSISTANT INTEGRATION". Status resolution, the provider source boundary, and the model-selection reconcile decision.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 993-1109); append rather than
rewrite.

---

- State:
  - packages/app-state/src/stores/assistant-preferences-store.ts
  - packages/assistant-data/src/assistant-thread-store.ts
  - Assistant preferences persist the most recently selected model as the default for the next
    new thread, plus a capped `recentModels` list (composite keys, newest first) that feeds the
    composer model menu's top-level rows. The thread store persists each existing thread's model and provider settings so
    switching chats or restarting the app restores that thread-specific runtime.

Assistant status endpoint resolution (in order):
1. window.assistant.getUrl()  (async)
2. window.assistant.url       (static)
3. /api/assistant/status      (fallback)

An enabled Hosted Web status response advertises its trusted primary runtime
pair plus every configured provider:
`{enabled:true,provider:<first configured>,model:<registry default>,providers:[...],providerKeySources:[...]}`.
The stable provider priority is OpenAI, Anthropic, Google, then OpenRouter. The
server and app shell consume the same provider registry: the shell validates the
primary pair, provider list, and environment provenance, skips renderer-side key
discovery, and derives each secondary provider's fixed registry-default model.
The primary pair remains atomic; a provider without a registry default, or any
incomplete, unknown, duplicate, or inconsistent metadata, fails visibly.
Desktop status may omit the pair, in which case its encrypted-key discovery
remains authoritative.

Desktop's non-fixed `providers` list is a validated seed, not an exhaustive
renderer catalog. The app shell must merge it with renderer provider discovery
so settings-owned, reachable or force-enabled Ollama and LM Studio runtimes
remain selectable. Hosted Web's fixed provider/default-model set stays
authoritative and must continue to skip renderer discovery.
`AssistantProviderSource`, provided at the `AssistantChatPanel` composition root,
is the required explicit boundary: a missing provider throws. `authoritative`
is derived synchronously during render, while `discovery` subscribes one shared
external resource to the secrets-store revision and the immutable Ollama / LM
Studio provider-settings snapshots. Unrelated provider settings never trigger
keychain enumeration or local-runtime probes. The first Desktop subscriber
starts discovery and the last subscriber tears down the live subscriptions, so
multiple mounted thread tabs never fan out duplicate runtime probes. The last
visible provider snapshot remains cached across a zero-subscriber period and is
rendered while the next subscriber revalidates; only the test reset clears it.
Every refresh carries a monotonically increasing generation; a superseded or
unsubscribed request cannot publish late. Unexpected key or runtime discovery
failures remain visible as a panel notice while explicit Desktop seeds stay
rendered; they are never converted to an empty successful result. The notice
blocks the composer only when the merged snapshot contains no usable provider.
A partial failure must not disable an independently verified or validated-seed
provider.
Ollama and LM Studio probes settle independently. If one unexpected probe
fails, every independently verified provider remains in the error snapshot and
the failed probe remains visible through the typed aggregate error; neither the
successful provider nor the failure may be discarded. Malformed main-process
bridge payloads use that same visible failure channel.
Idle and loading snapshots pause persisted-model reconciliation. Error snapshots
do not: their independently verified or last-known provider list remains the
selection authority while the error stays visible, so a failed sibling probe
cannot leave a disappeared provider selected forever.
Keep the authority, refresh, ordering, teardown, and failure controls in
`use-configured-assistant-providers.test.tsx` when this boundary changes.

**The reconcile itself is a pure decision, not an effect (BST-1652).**
`packages/app-shell/src/assistant-panel/model-selection-reconcile.ts` takes a
plain input snapshot and returns one `{kind: 'keep' | 'select' | 'clear'; reason}`
value; `use-model-selection-reconcile.ts` is the only thing that applies it and
holds no policy of its own. Branch ORDER is load-bearing — built-in-local
seeding, then the discovery pause above, then provider availability, then the
local-runtime leg, then registry re-selection — and every branch has a named
reason with a unit test in `assistant-panel/__tests__/`, so a new case belongs
in the pure module (testable without React or PGlite) rather than in the hook.
A `select`/`clear` is logged at debug with its reason; `keep` is the steady
state and is not logged. The mount-level oracle stays
`assistant-ui-panel-wrapper-provider-seeds.test.tsx`.

One deliberate wart is preserved and pinned: built-in-local seeding is gated on
the RENDER-captured selection (`renderedSelectedModel`) while every other branch
reads the live store, exactly as the pre-extraction effect did. Collapsing the
two is a separate, deliberate change — not a cleanup to fold into an unrelated
edit.

The mounted assistant wrapper keys local-runtime status and model-catalog
refreshes to the immutable Ollama / LM Studio settings snapshots; unrelated
provider settings do not trigger local probes. Changing activation, base URL,
or credentials invalidates both requests. Status is resolved before catalog
loading, and the combined refresh uses a monotonically increasing generation
so a response from an older settings snapshot cannot replace the new catalog.

Desktop status also reports each unreadable stored credential as a validated
`providerErrors` entry (`provider`, `api_key_unreadable`, typed error code, and
the safe repair message). One unreadable credential never hides other working
providers. The shared shell preserves these entries and disables only the
selected affected provider with the re-entry guidance; malformed or duplicate
entries fail the availability probe instead of being guessed at. An environment
credential remains authoritative and suppresses a stale stored-key read failure
for that provider.

Desktop status keeps keyless runtime availability in `providers` and reports
credential provenance separately in `providerKeySources`. Each entry is exactly
either `{provider,source:"stored"}` or
`{provider,source:"env",envVar:<declared name>}`; values never cross HTTP or IPC.
The renderer rejects duplicate providers, unknown sources, extra fields, and an
environment-variable name not declared for that provider. `secrets:list`
returns the same source metadata (including Tavily), while
`secrets:listStored` remains the keychain-only string list. Test-mode Secrets
IPC remains environment-blind. Settings merges status provenance with IPC
metadata so an injected test/launch credential is visible without weakening
that hermetic IPC boundary, and disables an inert Save action while an
environment key is authoritative.

An invalid desktop environment file leaves the assistant server reachable but
makes `/assistant/status` return the typed
`assistant_configuration_invalid` state with only safe logical-file failure
metadata and no partial provider availability. The shared status validator
maps that payload to a visible error state; it never falls back to stored keys.

Implementation:
- packages/app-shell/src/hooks/use-assistant-availability.ts

When changing this flow, update this doc.
