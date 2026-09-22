# R3 workspace ownership — evidence

Supports `docs/agents/mastra-boundary.md` § "R3 WORKSPACE OWNERSHIP". Read this
before proposing Mastra Workspace tools or relaxing a `resolveWorkspaceRoot`
failure. Tool inventories and line numbers below are 1.51-era measurements; the
failure conditions they enumerate are still the ones the resolver enforces.


**Brainstrike's native workspace tools remain authoritative. Mastra Workspace
(`createWorkspaceTools`, `LocalFilesystem`, `LocalSandbox`) is rejected.**

Mastra Workspace is genuinely in core at 1.51 — 14 `mastra_workspace_*` tools
(`read_file`, `write_file`, `edit_file`, `list_files`, `delete`, `file_stat`,
`mkdir`, `grep`, `ast_edit`, `execute_command`, `get_process_output`,
`kill_process`, `search`, `index`, `lsp_inspect`). It is rejected on two grounds:

**It has no identity or permission model.** Per-tool config is
`enabled | requireApproval | requireReadBeforeWrite | name | maxOutputTokens`.
Isolation comes only from the provider's `basePath`/`readOnly`. Brainstrike's
`resolveWorkspaceRoot` (`apps/desktop/src/assistant-server/workspace-roots.ts:159`)
resolves a rootId-or-displayName qualifier through a four-step precedence and
**fails loud on eight distinct conditions**: duplicate displayName (`:199-203`),
unknown qualifier (`:204-206`), stale binding (`:209-222`), ambiguity across
multiple roots (`:233-235`), zero roots (`:166-170`), unavailable inventory
(`:143-145`), disconnected root (`:105`), and path escape after realpath on both
sides (`workspace-path-resolution.ts:39-54`). Adopting Mastra Workspace would be a
downgrade in exactly the dimension Brainstrike is strictest.

**It collides with R2.** `@mastra/core/workspace` pulls the Node-builtin chunk.

The 27 desktop tool ids plus 3 skill ids are registered at a single site,
`apps/desktop/src/assistant-server/assistant-tools.ts:150`, where an unknown id in
the preference filter **throws** (`:713-716`) rather than being dropped.

