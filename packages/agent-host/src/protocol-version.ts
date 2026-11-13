/** The agent host wire protocol's version, and what each version changed. */
// 11: committed branch history (`run/start` parentMessageId, `run/regenerate`, and the explicit
// branch links they commit on `run.started`), thread presentation (`thread/update`,
// `thread.updated`: title, colour and icon, also in `thread/list`), withheld observational memory,
// tool catalog IDs on committed tool events, image attachments on a user message (`run/start` and
// `run.started`), committed workspace edit attribution, `checkpoint/revert`, per-thread tool state,
// the prompt breakdown on `provider.request.prepared`, run attempt records, `mcp.tools.unavailable`, committed with `run.started` for
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
// Additions since: `thread/tree` (a thread's summary and every thread delegated beneath it, as
// Core folds them) and its `thread/tree/changed` notice, and a wake that delivers the command
// sessions its runs started that ended by themselves (`run.started` delivery `commandSessions`,
// with `entries` then possibly empty), and the turn a run the host continued in the worktree its
// previous run entered carries on (`run.started` `turnId`; ADR-0028 step 3), and
// `interaction/preview` (the file text a waiting approval's call would change; ADR-0036), a new
// method.
// v20 (2026-11-05): `log/subscribe` answers a `subscriptionId`, and `log/unsubscribe` names it
// instead of the thread, so ending one view's subscription never ends another's. The required
// parameter is why this is a version bump. Additive since: `run.started` `hostPrompt`, set when
// the host wrote the run's prompt (the worktree continuation); a next-turn delivery carries the
// thread's ended command sessions too (`commandSessions`, with `entries` then possibly empty).
// v21 (2026-11-05): each `changes/resolve-view` entry carries the actions the host offers for it
// (`actions`) and the `revision` of what the view drew, and `revertible` is gone; `changes/apply`
// stages, unstages or reverts a view's hunks or files (ADR-0036), a new method. The required
// fields are why this is a version bump. Additive since: a turn's entries carry `wholeFile`,
// and a settled turn's view reverts whole files; `changes/commits` (a worktree's latest
// commits, for the Changes commit picker), a new method; `notice.posted` (a child run's report
// or a command session's exit, posted on the thread that hears it; ADR-0028 step 3b), a new
// variant; `model.messages` carries the notices a running run took at a step (`delivery`);
// `run/input` is a notice on any thread, read at the run's next step or starting the person's
// turn on an idle thread, and a delivery names the inputs it took (`inputs`, `ledger` optional).
// v22 (2026-11-05): `run/steer` is gone. A person's message to a running thread is `run/input`,
// which the run reads at its next step, so no run ends early to make room for it. Removing a
// method is why this is a version bump. Additive since: `model.usage` (what a run's thread title
// and Auto-review calls reported, costed under the model each ran on), a new variant.
// v23 (2026-11-10): `hooks/trust`, `hooks/trust/read` and `hooks/untrust` name a root by its
// `path` and no longer take a `rootId`, because an approval is recorded for the root's repository
// and the file's hash, which a managed worktree shares (BST-2340, ADR-0034 decision 6).
// `hooks/trust/read` answers `approvedSha256` in place of the stored trust. The required
// parameter is why this is a version bump. Additive since: a `workspace/trust/list` root carries
// `answeredBy`, the folder whose answer it shares when that is not itself (a managed worktree's
// repository).
// v24 (2026-11-10): each `changes/resolve-view` entry carries `pathInRoot`, the file's path inside
// its root, worked out from the root's and the worktree's resolved paths. A client no longer
// compares the root's own path with the worktree's, which differ by spelling for a root opened
// through a symbolic link. The required field is why this is a version bump. Additive since: a
// `thread/list` thread's latest run carries `waitingOn`, the kinds of unanswered request it waits
// on, present while `needsInput` is true (for the thread list's Needs you strip); trusted
// locations (ADR-0032): `workspace/trust` takes an optional `location`, a `workspace/trust/list`
// root carries `trustedThrough` and `offeredLocation`, `workspace/trust/read` answers
// `offeredLocation`, and `workspace/trust/locations` and `workspace/trust/locations/remove` are
// new methods.
// v25 (2026-11-11): a root record Main reads over `host/workspace-roots` carries `projectId`, the
// project its folder belongs to, or null for a root recorded as a managed worktree (ADR-0034,
// owner decisions 2026-11-10). Main decodes the record strictly, so it cannot read an older
// host's records and an older Main cannot read these. The required field is why this is a
// version bump. Additive since (ADR-0034 Automatic isolation, owner decisions 2026-11-11):
// `workspace.binding.updated` `enteredBy` carries `cause` when the host itself made the worktree
// it moved the thread into, and `checkout.shared` (a thread that edits a folder another thread's
// run is editing and was not moved), a new variant; `worktrees.archived` (the idle worktrees the
// cap archived after a worktree was created for the thread; ADR-0034 decision 7), a new variant.
// v26 (2026-11-12): scratch threads (ADR-0034, Sean 2026-11-12). A root record Main reads over
// `host/workspace-roots` may be of kind `scratch`, a folder the host made for a thread sent with
// no folder while none was open; Main decodes the kind strictly, so an older Main cannot read
// these records. Each root `workspace/roots/*` answers carries `scratch`, required.
// `thread/workspace/scratch` gives a thread with no folder its scratch folder and binds it before
// its first run, a new method. A `thread/delete` result carries `scratchFolderNotRetired` when the
// deleted thread's scratch folder was not moved to the Trash, an optional field.
// v27 (2026-11-12): the host keeps repository setup script consent (ADR-0034, Sean 2026-11-12), so
// every worktree it creates, its own included, runs the script of a repository approved at the
// script's hash. `worktrees/create` no longer takes `repositorySetupDecision`; the host reads its
// own record. `worktrees/create-context` answers the standing decision with the script
// (`repositorySetup.decision`), required. `worktrees/setup-consent/decide`,
// `worktrees/setup-consent/list` and `worktrees/setup-consent/revoke` are new methods. Removing
// the parameter and the required field are why this is a version bump. Additive since:
// `worktrees/list-archived` (the archived managed worktrees of a root's repository, newest archive
// first, which the where-control's picker restores; ADR-0034 decision 7), a new method.
// v28 (2026-11-12): a scratch thread's folder becomes a project (ADR-0034 build decisions).
// `thread/workspace/scratch/project`, for the desktop's private client, asks Main's folder picker
// where, moves the scratch folder there and turns its root into a folder of the person's with a
// project of its own under the same root id; a new method. Its refusals are typed
// (`workspace.scratch-*`).
export const AGENT_HOST_PROTOCOL_VERSION = 28;
