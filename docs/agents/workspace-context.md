# Workspace context and edits

Decisions: [ADR-0016](../adr/0016-workspace-trust-and-ignore-chain.md), [ADR-0032](../adr/0032-workspace-trust.md).
Implementation: `packages/host-capabilities` (workspace context and tools), `packages/agent-host` and `packages/file-explorer`.

## Root authority

- Canonical RootId and the agent host's mounted-root registry authorize access; a saved path, selected folder or managed worktree row alone does not (ADR-0029 stage 4).
  - Revalidate the same binding after awaited work.
  - Registry add, restore and disconnect complete before renderer projection; a failed removal leaves the root connected.
- The registry (`@brainstrike/host-capabilities/workspace-roots`) is the one writer of the open folders and their order (`roots.open_position`), the recent-folders ledger and each folder's grant-time identity (`roots.canonical_path`).
  - It serves `workspace/roots/*` to the desktop's private client only; Main answers the picker (`platform/workspace/pick-folder`) and nothing else about folders.
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

## Instructions, prompts and skills

- A folder's agent configuration (AGENTS.md/AGENT.md/CLAUDE.md, project skills, slash commands, subagent personas) loads only once the person trusts the folder.
  - The host records each answer by canonical path (`packages/agent-host/src/workspace-trust.ts`) and is its only writer.
  - A managed worktree shares its repository's answer (ADR-0034 decision 6). A folder is one only while the worktree ledger lists it and git's two links still join it to that repository; neither a ledger row nor a folder's own `.git` is enough alone.
  - Pass a run's or listing's roots through `trustedHostWorkspaceRoots` before scanning project tiers.
  - A folder with no answer is trusted when the folder that answers for it lies inside a trusted location (ADR-0032). Read trust only through `readHostWorkspaceTrustAnswer` or `readHostWorkspaceTrust`, never from the `workspace.trust/…` settings, so every reader agrees.
    - `writeHostWorkspaceTrust` is the only writer of a location: with a `trusted` answer, on the person's explicit request, as the parent of the folder being trusted. Never add one from a run, a scan, a headless start or anything a folder contains.
    - The host says which parent may be named (`offeredLocation`, from `hostTrustedLocationOffer`). Show that path and send it back; never work a parent out in a client.
    - A folder counts only when the person alone can add to it: they own it, and neither its group nor everyone can write to it. That holds for the location, the folder itself and every folder between. A test that expects a location to cover a folder makes its folders with mode `0o755`, since the machine's umask may leave them group-writable.
    - A folder the app itself creates is recorded as trusted through the same writer when it is created, and never a folder that already existed. No such action exists yet.
  - The composer's chip asks only about the thread's own folders (the binding's operating folder and secondaries; every open folder while it has none), once per answer. `workspace/trust/list` names the answering folder (`answeredBy`); group by it rather than matching paths in the renderer.
  - An untrusted folder still mounts and stays readable and editable.
  - Home tiers load regardless; hooks keep their own hash pins.
    - A hook approval is for exact bytes, recorded under the same answering folder as workspace trust (`hostAnsweringFolder`, `packages/agent-host/src/answering-folder.ts`), so a managed worktree runs the one version its repository approved.
    - Resolve whose answer a folder shares through that one function; never match a worktree to its repository another way.
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
