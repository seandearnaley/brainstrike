# MCP content application port — evidence

Supports `docs/agents/assistant-providers.md` § "MCP 2026 host architecture". The browser-safe content seam, its Settings and composer callers, and the prompt slash-command projection.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 3536-3652); append rather than
rewrite.

---

BST-1578 adds `@brainstrike/assistant-service/mcp-content-application-port`, a browser-safe seam
limited to `resources/read`, `prompts/get`, and `completion/complete` for one authorized server
generation. Inputs must fit 256 KiB before invocation. One filtered watch and cancellation lease
check authority around registration and invocation; the generation must be connected and advertise
the catalog feature. Capability/state, cancellation, retirement, snapshot, watch, unknown invoke,
and result-validation failures retain public or diagnostic taxonomy. The required internal-error
sink receives raw causes on the trusted redaction path; public errors remain fixed, cause-free, and
safe. Schema-validated, operation-matched results are limited to 4 MiB serialized UTF-8 and reject
overflow. The seam exposes no raw `invoke`, SDK client, renderer IPC/UI/persistence, subscription,
or automatic model-context injection.

BST-1585 gives each of those three verbs one production caller: user-initiated catalog browsing in
Settings (`packages/settings-ui/src/settings/tools/mcp-support-status.tsx`). `Read` on a listed
resource issues `resources/read`; `Use prompt` opens an inline argument form whose inputs call
`completion/complete` (`ref/prompt`) for suggestions and whose submit issues `prompts/get`.
Completion is gated on the server's advertised `features.completion`, debounced (250 ms), skips
empty input, and dedupes values. Bodies render bounded (text truncated at 2 KiB, at most 20
contents, messages, or suggestion values per view, blobs and non-text content shown as metadata
only) and are never eager model context; the catalog remounts per server generation so a retired
generation's content or draft never carries over. Desktop main
owns one `createMcpContentApplicationPort` per host runtime (`apps/desktop/src/mcp/content-port.ts`,
memoized so factory reset keeps the singleton) with the main-process logger as the required
internal-error sink. The `mcp:content:readResource` / `mcp:content:getPrompt` /
`mcp:content:complete` channels (`apps/desktop/src/mcp/content-ipc.ts`) each force their own verb
server-side, validate the renderer payload strictly, wait on the MCP lifecycle barrier and reject
while admission is closed, but never enter the non-reentrant config-operation queue. They carry the
same fail-closed `visible-ui` sender policy as secrets (hidden inference hosts and untracked senders
are rejected before any payload is parsed). Failures travel as a result envelope
(`{ ok: false, error: { category, code, message } }`) rather than a thrown Error, because
`ipcMain.handle` replies to a throw with Electron's formatted string, main-process stack included;
the preload unwraps the envelope into a clean Error whose message is `message (category · code)`.
Only that fixed taxonomy crosses IPC: `hostError` text is server-originated and stays in main. The
renderer never sees `invoke`: the preload bridge exposes exactly `readResource`, `getPrompt`, and `complete`, and
settings-ui receives them as optional `readMcpResource` / `getMcpPrompt` / `completeMcpContent`
operations gated on bridge presence, so web omits the affordance entirely. Pinned by
`apps/desktop/src/__tests__/main/ipc-mcp-content.test.ts`,
`apps/desktop/src/__tests__/preload-runtime-contract.test.ts`,
`apps/desktop/src/__tests__/renderer/components/settings/page-content-operations.test.tsx`, and
`packages/settings-ui/src/settings/tools/__tests__/unified-tools-settings.test.tsx`.

BST-1592 makes prompts selectable from the COMPOSER, so using a prompt no longer requires opening
Settings. MCP prompts are a FOURTH entry kind in the same `SlashCommand[]` the app commands,
user-defined `/commands`, and Agent Skills already flow through
(`packages/app-shell/src/use-mcp-prompt-slash-commands.ts`, merged last by
`useAssistantSlashCommands`) — there is no parallel autocomplete surface. The list is a pure
projection of the revisioned host snapshot (`mcp-prompts/mcp-prompt-catalog.ts`): only a CONNECTED
server that advertises `features.prompts` and listed the prompt is offered, ordered by configured
server id then prompt name. Two servers may expose the same prompt name, so both the command id
(`mcp:<configuredServerId>:<promptName>`) and the menu label (`<title> · <configuredServerId>`)
carry the configured server id — with `:` and `\` ESCAPED in both components, because a
configured server id and a server-authored prompt name may each contain the delimiter and plain
concatenation is then not injective (server `a` + prompt `b:c` and server `a:b` + prompt `c` both
produce `mcp:a:b:c`, and the duplicate-drop would discard one valid prompt). Every ordinary id is
byte-identical after escaping and the LABEL keeps the raw values. The two snapshot channels (the
initial `getServerStatusSnapshot()` read and the pushed `onServerStatusUpdated` events) are ordered
by `McpHostSnapshot.revision`, not just by the effect generation: a late-resolving older snapshot is
DROPPED, so a slow initial read can never restore a list a newer push already replaced.

Desktop-only by construction: `resolveMcpPromptBridge()` requires all four `window.mcp` members
(`complete`, `getPrompt`, `getServerStatusSnapshot`, `onServerStatusUpdated`) and returns a
three-state resolution. `unsupported` (no `window.mcp`, or a host exposing NONE of the content
members) is a legitimately absent capability and stays quiet — that is web. `malformed` (SOME but
not all members) is a preload/packaging defect: `McpPromptComposerHost`, which is always mounted,
names the missing members in a destructive toast, so the capability can never vanish into something
indistinguishable from web. The two states never share a code path.

Selecting a prompt performs NO request. `execute` captures the live draft split around the typed
trigger (the adapter strips it afterwards, and the popover can be invoked mid-draft, so trailing
text must survive) and hands the selection to the app-wide `McpPromptComposerHost`
(`packages/app-shell/src/mcp-prompts/mcp-prompt-host.tsx`, mounted beside `McpElicitationHost` in
`root-layout-content.tsx`). That host owns every effect: an argument-less prompt stages immediately;
an argument-taking prompt opens `McpPromptDialog`, whose inputs call `completion/complete`
(`ref/prompt`, 250 ms debounce, empty input skipped, values deduped and capped at 20) and whose
submit issues `prompts/get`. The pinned generation is watched for the lifetime of the selection, so
a server that disconnects mid-selection blocks submission with a visible message instead of
retargeting another generation — the visible half of a failure the content port would reject anyway.
The result lands in the composer DRAFT via `assistant-composer-command-store`, never auto-sent and
never eager model context: the same contract as user-defined `/commands` and Agent Skills. Two
things are re-checked AFTER the `prompts/get` await, because the composer stays live across it.
First, the pending selection: the dialog is deliberately still dismissible mid-request (Escape and
outside click reach `onOpenChange`; a modal that cannot be closed is worse UX than one that can), so
`stage()` re-reads the selection store and discards a result whose selection was dismissed or
replaced — the abort is honoured where the write happens, not by disabling the escape hatch. Second,
the draft: `mode: 'replace'` uses the SELECTION-time split only while the live draft is still the one
that split was computed against — either the draft as it stood when the prompt was picked, or the
draft the popover leaves after its own `setText(before + (after.startsWith(' ') ? after.slice(1) :
after))` strip. Once the user has typed (or sent and started a fresh draft) the prompt is APPENDED to
the live draft instead, so a slow prompt can never silently overwrite what they wrote.

The typed trigger is located as the LAST whitespace-delimited `/token` in the draft, not as a
`/mcp:`-prefixed one: the pinned adapter's `matchesQuery` is a SUBSTRING test over id, label, and
description, so `/echo` legitimately selects `mcp:legacy:echo_reference`, and a `/mcp:`-anchored
match left that token in the staged draft. The leading-boundary group keeps a URL path from being
mistaken for a trigger, and scanning all matches (rather than a `(?!.*…)` lookahead, whose `.` never
matches `\n`) makes the "last trigger wins" rule hold across LINES.

A single user text message stages verbatim; anything else is role-labelled, and
image/audio/resource parts are REPORTED in a toast rather than dropped, with a prompt carrying no
text at all failing visibly.

`completion/complete` with `ref/resource` has NO product caller and stays HOST-ONLY: it exists on the
typed `invoke` union and the content port for a future resource-TEMPLATE surface, and resource
contents entering assistant context remains out of scope until a bounded-context design exists. Do
not add a caller for it as a side effect of another ticket. Every content VERB
(`resources/read`, `prompts/get`, `completion/complete`) now has a product caller.

The packaged proof runs in `apps/desktop/e2e/mcp-packaged-core.desktop.test.ts` against the
Brainstrike-owned echo reference fixture (the `legacy` server), NOT the pinned official everything
profile: Settings `Read` on the echo resource proves `resources/read` reaches the renderer, and the
composer "/" menu → argument dialog → `Insert prompt` proves `prompts/get` does, with the server's
own message text asserted in the composer draft. The fixture gained that content in
`packages/mcp-test-lab/src/reference-server.ts` (`ECHO_REFERENCE_CONTENT`); its `completions`
capability comes from a `completable()` prompt argument, which also installs the SDK's own
`completion/complete` dispatcher — a hand-written handler for that method would collide with it.
Pinned by `packages/app-shell/src/__tests__/mcp-prompt-catalog.test.ts`, `mcp-prompt-text.test.ts`,
`use-mcp-prompt-slash-commands.test.tsx`, `mcp-prompt-host.test.tsx`, and
`packages/mcp-test-lab/__tests__/lab-http.integration.test.ts`.
