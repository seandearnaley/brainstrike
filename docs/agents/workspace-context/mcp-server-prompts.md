# MCP server prompts as slash entries — evidence

Supports `docs/agents/workspace-context.md` §
"MCP SERVER PROMPTS — the fourth slash-entry kind".
Read before changing how connected MCP servers' prompts are merged into the composer "/" menu.

The record below is the prose that stood in the contract before it was
distilled to the contract/evidence idiom, extracted verbatim. The contract
holds the rules that are true today; where the two differ, the contract wins.

## Record

Prompts published by connected MCP servers, merged LAST into the same
`SlashCommand[]`. Desktop-only by construction (`resolveMcpPromptBridge()` needs
the visible-UI preload's `window.mcp` content + status members; web returns
`[]`, while a PARTIAL bridge is a defect the always-mounted host reports out
loud). Ids are `mcp:<configuredServerId>:<promptName>` with `:` and `\` escaped
in both components (both may contain the delimiter, and a non-injective id would
drop a valid prompt), and labels are `<title> · <configuredServerId>` with the
raw values, because two servers may expose the same prompt name and the user
must see WHOSE prompt they are staging.

Because the pinned popover cannot capture inline args (the F1 constraint above),
an argument-taking prompt opens a MODAL (`packages/app-shell/src/mcp-prompts/`)
whose inputs are backed by `completion/complete` (`ref/prompt`); an
argument-less prompt stages immediately. Either way `prompts/get` runs only on
that explicit action, and the result is written to the composer DRAFT — never
auto-sent, never eager model context. Both the pending selection and the live
draft are re-checked AFTER the await: a dismissed dialog stages nothing, and a
draft the user has edited meanwhile is APPENDED to rather than replaced. Full contract, failure taxonomy, and
packaged proof: `docs/agents/assistant-providers.md` (BST-1592).

When changing this flow, update this section and the paired tests.


