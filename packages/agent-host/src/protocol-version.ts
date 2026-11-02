/** The agent host wire protocol's version, and what each version changed. */
// 11: committed branch history (`run/start` parentMessageId, `run/regenerate`, and the explicit
// branch links they commit on `run.started`), thread presentation (`thread/update`,
// `thread.updated`: title, colour and icon, also in `thread/list`), withheld observational memory,
// tool catalog IDs on committed tool events, image attachments on a user message (`run/start` and
// `run.started`), committed workspace edit attribution, `checkpoint/revert`, per-thread tool state,
// the prompt breakdown on `provider.request.prepared`, `run/steer` (end the active run at its next
// step boundary), run attempt records, `mcp.tools.unavailable`, committed with `run.started` for
// each configured MCP server whose tools the run proceeds without, permission grants answered with
// an approval (`interaction/respond` grant, `permission.granted`, the request's risk), plan mode
// (`run/start`, `run/regenerate` and `run.started` planMode), child threads (BST-1932):
// `thread.started` with a delegation `origin`, the child results a `run.started` delivers, an
// approval the root's policy answered, and `thread/children` (a thread's direct children),
// lifecycle hook context (`hook.context`), host-owned project hook trust (`hooks/trust`,
// `hooks/trust/read`, `hooks/untrust`), `thread/memory/read` (memory readiness for the next run),
// run_python's network consent (an `interaction.requested` of kind `network`, answered by
// `interaction/resume` with `{ action }` and, when the policy also asked, an approval grant), a
// run's turn snapshots for its Changes review (`workspace.snapshot.recorded`), restore to before a
// message (`thread/rewind/preview`, `thread/rewind`, `thread/rewind/redo`; `thread.rewind.started`,
// `thread.rewound`, `thread.rewind.redo.started`, `thread.rewind.redone`,
// `thread.rewind.interrupted`), the hook files a run did not load (`hooks.skipped`), `ledger/read`
// (every thread's runs and costed provider calls, as Core folds them), the threads `thread/delete`
// deleted (`threadIds`), and the desktop's MCP settings (`mcp/config/*`, `mcp/extensions/*`,
// `mcp/tools/*`, `mcp/settings/subscribe` and its `mcp/settings/event`) with server status and
// control (`mcp/status/read`, `mcp/server/control`, the event's `status` variant), and its MCP
// presentations (`mcp/tasks/list`, `mcp/tasks/act`, `mcp/elicitation/settle`,
// `mcp/presentation/subscribe` and its `mcp/presentation/event`), content browsing
// (`mcp/content/complete`, `mcp/content/prompt`, `mcp/content/read`), an MCP App's own tool calls
// (`mcp/app/admit`, `mcp/app/call`), which Core decides under the owning thread's policy, and
// `worktree.created` (a worktree a call's shell command made, which the desktop adopted), and a
// provider request's tool calls (the breakdown's `toolCallsTokens` and `toolCallsByTool`, and the
// request's `toolCallWindow`), `state/health/read` (BST-1880), and `thread/memory/read`'s
// observation lifecycle, reflection threshold and memory models (BST-2201). These additions are
// optional fields, new variants and new methods, so a v11 reader that uses none of them sees
// nothing new.
// v12 (2026-10-18): `mcp/config/read` returns the config text's `revision` (a SHA-256 of its
// content). `mcp/config/write` requires `baseRevision` and refuses a stale base with
// `conflict: true` instead of overwriting. Write and catalog-install successes return the new
// `revision`. The required parameter is why this is a version bump and not a v11 addition.
// Config status carries `watchError` while the config file watcher cannot run. Additions since:
// `memory/embedder/probe` (BST-2227), a new method, so a v12 client that never calls it sees
// nothing new; `memory.recall.failed` (a turn's failed semantic recall, which the turn answers
// without), a new variant.
// v13 (2026-10-22): ChatGPT subscription sign-in is removed: `auth/connect`, `auth/cancel`,
// `auth/disconnect`, `auth/status`, `auth/verify` and the host-to-client `client/open-external`
// are gone, and a login credential is an API key or an AWS credential. Additions since:
// `workspace/skills` and `workspace/commands` (ADR-0029 stage 2), new methods.
// v14 (2026-10-26): `forge/*` and the git history, staging, pull and diff methods are gone.
// Additions since: `canvas/list` and `canvas/read` (the Artifacts gallery), and workspace trust
// (`workspace/trust`, `workspace/trust/read`, `workspace/trust/list`; ADR-0032), new methods.
// v15 (2026-10-31): `terminal/*` and `command-sessions/*` results are the one boundary
// envelope: a failure is a `BoundaryFailure` instead of a string or a `{ code, message }` pair,
// and a call with nothing to return answers `value: null`. The required field is why this is a
// version bump.
// v16 (2026-10-31): `auth/clear` is gone; a factory reset deletes the credential store (ADR-0015).
// Additions since: `workspace/personas` and `workspace/context-files` (ADR-0029 stage 2a), and
// the Explorer's root watches (`workspace/files/watch`, `workspace/files/unwatch`,
// `workspace/files/watch-retry` and the `workspace/files/event` stream) and reads
// (`workspace/files/list`, `workspace/files/read`, `workspace/files/exists`; ADR-0029 stage 4),
// and the workspace's open folders (`workspace/roots/*`; ADR-0029 stage 4), with
// `workspace/roots/open`, which replaces them (ADR-0034), and the Explorer's live text search
// (`workspace/files/search` and its `workspace/files/search/batch` stream; ADR-0035).
// v17 (2026-11-01): semantic recall and memory embeddings are gone (the retrieval decision,
// BST-2428): `memory/embedder/probe`, the `memory.recall.failed` event, `memory.usage` of kind
// `embedding` and `thread/memory/read`'s embedder model are removed.
// v18 (2026-11-01): the workspace index is gone (BST-2436): `workspace/search`,
// `workspace/roots/mounted`, `workspace/roots/reserve-data-deletion` and
// `workspace/roots/release-data-deletion` are removed, and `workspace/roots/delete-data` takes
// the folder's `rootId` instead of a reservation.
// v19 (2026-11-02): `workspace/roots/delete-data` is removed with the Explorer's "Also delete
// folder data" option; disconnecting a folder keeps its record for a later re-add.
export const AGENT_HOST_PROTOCOL_VERSION = 19;
