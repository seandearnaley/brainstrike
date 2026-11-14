# Workspace context and edits

Decisions: [ADR-0016](../adr/0016-workspace-trust-and-ignore-chain.md), [ADR-0032](../adr/0032-workspace-trust.md).
Implementation: `packages/host-capabilities` (workspace context and tools), `packages/agent-host` and `packages/file-explorer`.

## Root authority

- Canonical RootId and the agent host's mounted-root registry authorize access; a saved path, selected folder or managed worktree row alone does not (ADR-0029 stage 4).
  - Revalidate the same binding after awaited work.
  - Registry add, restore and disconnect complete before renderer projection; a failed removal leaves the root connected.
- The registry (`@brainstrike/host-capabilities/workspace-roots`) is the one writer of the open folders and their order (`roots.open_position`), the recent-folders ledger and each folder's grant-time identity (`roots.canonical_path`).
  - It serves `workspace/roots/*` to the desktop's private client only; Main answers the picker (`platform/workspace/pick-folder`), and moves a deleted thread's scratch folder to the Trash (`platform/workspace/trash-scratch-folder`), and nothing else about folders.
- The registry owns each folder's one `SecureRoot`.
  - Reads, watches and run borrows borrow it (`useMountedRoot`, `root-pins.ts`, source leases); never open a second handle in the host.
  - A mount closes only after its borrows end.
- A restore or picker-less reopen whose path resolves to another folder than the one granted is refused and shown as needing reconnect, never adopted. Only a fresh picker grant re-pins the record.
- A store that opened damaged is read-only (BST-2144).
  - The registry mounts and serves the open folders but records and converges nothing.
  - Every change (pick, add, remove, seed) is refused with the store's read-only refusal before it touches a folder or opens the picker.
- Disconnecting a folder keeps its root record, so re-adding the folder keeps its identity. There is no per-folder data deletion; a factory reset clears every record.
- Main root is the assistant's operating root; focused root is incidental UI selection.
  - Keep Main ordering across restore and re-add.
  - A terminal cwd pin is shell-only and never changes assistant authority.
  - Rebuilt handles carry their durable root ID, not a selection or cache folder ID.

- Scratch threads (ADR-0034, Sean 2026-11-12): a thread first sent with no folder while none is open works in a folder the host makes for it, `<userData>/scratch/<name>`, bound before its run is admitted.
  - The renderer's first send asks `thread/workspace/scratch` before `run/start`, only when the draft has no folder and no folder is open. The host makes nothing while a folder is open (the registry checks, in its own order of changes), and a thread that already works in a folder keeps it.
  - The folder is made outside Core's admission queue, then bound through the binding's own command (`thread-scratch.ts`). Never make or bind it from inside admission.
  - The platform's `HostPlatform.scratchFolders` (`scratch-folders.ts`, composed in `desktop-node-platform.ts`) makes the leaf alone under the canonical scratch directory, named by `generateWorktreeName`, records it trusted, and has the registry mount and record it (`addScratchRoot`, `register-scratch`). A thread's recorded folder is reused, so no second is made.
  - A scratch root mounts the first time its thread needs it, never at launch (BST-2512): a run's admission or a binding change (`mountScratchRoots`, from `desktop-workspace-binding.ts`), or the window's reconnect when the thread opens. Until then its record is disconnected, so no reader of live roots sees it. It is never an open folder, a Recents entry or a project. It reaches the renderer marked `scratch`; the Explorer shows only the active thread's (`threadCheckoutView`), and a run with no folder of its own never sees another thread's (Main's admission roots leave scratch roots out).
  - Deleting the thread, after its rows are erased and outside the admission queue, unmounts the folder, deletes its records and trust answer, and has Main move it to the system Trash (`platform/workspace/trash-scratch-folder`). Main moves only a folder directly inside `<userData>/scratch`, by canonical path. The thread is already gone, so a failure never fails `thread/delete`: it is logged and the result names the folder and why (`scratchFolderNotRetired`), which the window shows.
  - A run names the Explorer's focus only when its thread can see that folder: an open folder or one of its own (`threadSelectionFolderId`). The Explorer keeps its last focus while the active thread shows none, so never send that focus unchecked.
  - The Threads panel's Project grouping lists every scratch thread in one Scratch section (`SCRATCH_FOLDER_SECTION_ID`, `folder-scratch`), read from the root record's kind on Main's `readRoots` answer (`ThreadCatalogRoot.scratch`), never from the mounted roots' flag, a path or a name. `thread-panel-visible-rows.ts` keeps its own list of section-id shapes: a new section id goes there too.

## Instructions, prompts and skills

- A folder's agent configuration (AGENTS.md/AGENT.md/CLAUDE.md, project skills, slash commands, subagent personas) loads only once the person trusts the folder.
  - The host records each answer by canonical path (`packages/agent-host/src/workspace-trust.ts`) and is its only writer.
  - A managed worktree shares its repository's answer (ADR-0034 decision 6). A folder is one only while the worktree ledger lists it and git's two links still join it to that repository; neither a ledger row nor a folder's own `.git` is enough alone.
  - Pass a run's or listing's roots through `trustedHostWorkspaceRoots` before scanning project tiers.
  - A folder with no answer is trusted when the folder that answers for it lies inside a trusted location (ADR-0032). Read trust only through `readHostWorkspaceTrustAnswer` or `readHostWorkspaceTrust`, never from the `workspace.trust/…` settings, so every reader agrees.
    - `writeHostWorkspaceTrust` is the only writer of a location: with a `trusted` answer, on the person's explicit request, as the parent of the folder being trusted. Never add one from a run, a scan, a headless start or anything a folder contains.
    - The host says which parent may be named (`offeredLocation`, from `hostTrustedLocationOffer`). Show that path and send it back; never work a parent out in a client.
    - A folder counts only when the person alone can add to it: they own it, and neither its group nor everyone can write to it. That holds for the location, the folder itself and every folder between. A test that expects a location to cover a folder makes its folders with mode `0o755`, since the machine's umask may leave them group-writable.
    - A folder the app itself creates is recorded as trusted through the same writer when it is created, and never a folder that already existed. The one such folder is a scratch folder (below); its answer is forgotten before it goes to the Trash (`forgetHostWorkspaceTrust`).
  - The composer's chip asks only about the thread's own folders (the binding's operating folder and secondaries; every open folder while it has none), once per answer. `workspace/trust/list` names the answering folder (`answeredBy`); group by it rather than matching paths in the renderer.
  - An untrusted folder still mounts and stays readable and editable.
  - Home tiers load regardless; hooks keep their own hash pins.
    - A hook approval is for exact bytes, recorded under the same answering folder as workspace trust (`hostAnsweringFolder`, `packages/agent-host/src/answering-folder.ts`), so a managed worktree runs the one version its repository approved.
    - Resolve whose answer a folder shares through that one function; never match a worktree to its repository another way.
  - The worktree setup script (`.brainstrike/worktree-setup.sh`) has its own pinned answer, kept by the host (ADR-0034, owner decision 2026-11-12): one setting, `worktrees.setup.consent`, keyed by the repository's realpath'd git common dir, read and written only through `packages/host-capabilities/src/git-workspace/worktree-setup-consent.ts`.
    - Only a person's answer writes it (the create sheet's Allow or Skip through `worktrees/setup-consent/decide`, Settings › Workspace's Revoke). The writer re-hashes the script and refuses an answer for other bytes. Never record one from a run.
    - The worktree service reads it on every create (`readRepositorySetupConsent`), so a worktree the host makes runs the script too; `worktrees/create` carries no decision. `resolveSetupCommand` re-hashes before running and fails closed.
    - The checked bytes run from a private copy (`runWithPrivateScript`: a 0700 `mkdtemp` directory, removed however setup ends). Never open the script by its path again after the check: a run that can write the checkout could swap it in between.
    - `worktrees/create-context` answers the standing decision only for the script's current hash; a client never compares hashes itself.
  - Any new repo-supplied input that steers the agent goes behind the same filter.
- Every host (desktop and CLI) scans and injects these through `@brainstrike/host-capabilities/workspace-context` (ADR-0029 stage 2a).
  - Settings reads them over the host methods `workspace/skills`, `workspace/commands`, `workspace/personas` and `workspace/context-files`; the last two answer only the desktop's private client. Main serves none of them.
- Use the shared contained, size-bounded readers for instructions, references, commands and skills.
  - Respect scoped precedence and hard ignore rules; report omissions and keep Unicode boundaries when limiting context.
  - Never bypass the host's privacy or token-cap policy with a raw filesystem read.
- Slash commands and MCP prompts are explicit selections, not automatic execution. External content supplies text, not filesystem or permission authority.
- Only the trusted, enabled winning skill can run its registered script.
  - Verify skill/root containment, a supported interpreter and the declared allowed tools.
  - Spawn structured argv through the existing permission/process lifecycle, never a shell string rebuilt from model input.
  - Workspace-local skills stay bound to their root; global skills still need an explicit mounted target.

## Writes and undo

- Read-before-write is a thread-scoped compare contract.
  - Record content-bearing reads and successful own writes under the same per-file lock; snippets are not a full read.
  - Compare canonical targets inside that lock and return a typed reread refusal on mismatch.
  - New, unobserved or vanished files follow the existing compare-only policy; it doesn't require reading every new path.
- The host records the first pre-edit baseline and committed attribution per run and path.
  - Undo uses those baselines, refuses an active run, revalidates the root and reports disk conflicts instead of overwriting.
  - Unavailable baselines stay visibly unavailable.
  - Renames and multi-run undo keep ordered, idempotent restoration.
- Whole-turn shadow Git and per-edit baselines are separate owners; thread deletion and reset retire content through them.
- Automatic isolation (ADR-0034, owner decisions 2026-11-11): a run's first file edit in a folder that another thread's run in progress has edited is not run there ([rule](../../packages/agent-host/src/checkout-isolation.ts)).
  - The host makes a worktree of that checkout from its last commit, moves the thread through the binding's own command (ADR-0028 step 3) and settles the call unrun with what the model needs to carry on. The run ends after that step and the turn goes on in the worktree. Never re-bind a live run.
    - The worktree entry reads the run's signal before it queues the binding's command (`hostWorktreeEntry`), for this move and for the model's own worktree tool. A deletion, a Stop and the host's close abort the run and then wait for it, so a command queued behind that wait never runs and the host stops admitting commands.
  - "Being edited" is read from what Core already holds: each run in progress, its committed edit records and its edit calls in flight. A run's first edit in a folder is decided in the admission queue with the commit of its start. Add no second record of who writes a folder.
    - A run waiting on an unanswered approval is in progress.
  - Only the file tools count, and they are the tools that name their folder (`approvalTarget`). Shell commands do not.
  - A thread and its workers are one writer. A worker's edits count as its thread's for as long as the run that dispatched it is in progress, whether or not the worker has ended (`origin.parentRunId`). A worker's own clashing edit is made in place and never moves its parent; the note (`checkout.shared`, `workers-running`) is committed to the person's own thread, at the run and call that dispatched the worker.
  - A thread stays, and its transcript says the folder is shared and why (`checkout.shared`), wherever it is not given a worktree: it has uncommitted edits of its own there, its workers still work there (one dispatched in the same step included), the folder is one of its other folders, or the folder cannot be given a worktree.
    - The platform's `create` names that last case before it creates anything (`noWorktree`): the folder is not a git repository, its repository has no commit yet, it is inside a repository below its top folder, or git cannot read it on this machine (git missing from PATH, or any other failure to read the repository, which is logged).
    - "Uncommitted edits of its own" are the paths in the edit records of the thread and its workers that git's status reports. Ignored files and a shell command's changes are not seen. Another thread's change to such a path counts too, since git cannot tell whose it is.
  - The edit is refused with the reason, and nothing is written in place, only when a worktree should exist and could not be made, or when a thread reaches back into the checkout it left for its worktree. The reach-back is refused before anything else is weighed, so a path it once edited there never lets it back in.
  - A worktree that was made and never entered stays in the ledger, bound to no thread: its run was stopped or its thread deleted meanwhile, or a worker began in the same step. It is idle, so the idle-worktree cap below archives it once its repository has more than 15.
  - The platform supplies the git facts and the worktree (`HostPlatform.checkoutIsolation`, composed from the worktree tool's own create-and-open). A host without it (the standalone host) does not apply the rule.
- The idle-worktree cap (ADR-0034 decision 7, owner decisions 2026-11-12): after a managed worktree is created for a thread, its repository keeps at most 15 idle managed worktrees and the oldest beyond 15 are archived ([cap](../../packages/host-capabilities/src/git-workspace/worktree-idle-cap.ts)).
  - Idle is decided against every existing thread's committed binding, read from Core's thread list. A worktree a binding names as its worktree or as any of its folders is never idle; the worktree just made is not counted. Decide it this way only; never from the ledger's creator thread.
  - It archives only through the worktree service's own serialized `archive`, the one a person's archive uses, with `idleCap` ([its checks](../../packages/host-capabilities/src/git-workspace/worktree-idle-archive.ts)); never around it. That turn reads the bindings again and refuses a bound, locked, nested-repository or active-run worktree, which the cap leaves in place; anything else is forced, with the preview's token for ignored files, because the snapshot keeps the work and the branch stays.
  - It starts as the creation returns, which never waits on it, runs one cap at a time, and logs a failure with its repository and worktree. Core tells the creation's thread in a committed `worktrees.archived` row (`HostPlatform.idleWorktreeArchives`, `reason: 'idle-cap'`). A creation that names no thread runs no cap.
- Archive on merge (ADR-0034 build decisions, BST-2504): before the cap counts, and once in each repository with live worktrees after the host opens, each idle worktree whose branch has commits of its own and adds nothing the default branch lacks is archived through the same `idleCap` archive, which deletes ignored files as the cap does ([pass](../../packages/host-capabilities/src/git-workspace/worktree-merged-archive.ts), [merged test](../../packages/host-capabilities/src/git-workspace/worktree-merged.ts)).
  - Merged means: on a branch, no uncommitted changes, a tip that has moved from the commit the ledger recorded at creation (`base_commit`, BST-2518; a worktree never committed to is never archived on merge, wherever it was made, and a row with none recorded is never merged), a tip that is not on the default branch's first-parent history (so a branch only fast-forwarded, rebased or reset along it is never archived on merge, and one of unrelated history is not merged), and `git merge-tree --write-tree <default> <branch>` writing the default branch's own tree, which catches squash merges. Never `merge-base --is-ancestor` alone, which misses them, and never the branch reflog, which counts a fast-forward as work.
  - The default branch is the local `origin/HEAD` or `origin/main` (`default-branch.ts`); the host never fetches. Git older than 2.38, a repository with no default branch, one whose own config names a merge driver, or a partial clone (a promisor remote, which `merge-tree` would fetch a missing blob from) archives nothing and logs why; a content merge would run that driver. The archive's own turn asks all of this again, not only whether the branch merged.
  - The base commit is host-only: `ManagedWorktreeRow` does not carry it, because clients decode it strictly; read it with `WorktreeLedger.baseCommit`.
  - The thread that made the worktree (the ledger's `threadId`) is told with its latest run (`reason: 'merged'`); a worktree whose maker is gone, or has no run, is archived and logged. A `worktrees.archived` row with no `reason` (committed by a v25 to v29 host) is the cap's and must keep decoding.
