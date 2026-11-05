# ADR-0028: Subagents, sessions and agent messaging work as Claude Code does, across hosts

- **Status:** Proposed. The owner decided every open question on 2026-10-22 (see Owner
  decisions) and may mark it Accepted.
  - Implemented so far: step 2 (children never get `askUser` or `submitPlan`;
    `PARENT_ONLY_TOOL_IDS` in `packages/assistant-contract/src/personas.ts`), step 3 for
    root runs (a created worktree binds its thread; `packages/agent-host/src/worktree-binding.ts`),
    and step 3b's notice for child reports, command-session exits and a person's input, taken at
    a run's start or its next step (`packages/agent-host/src/notices.ts`).
  - Not yet: steps 4–10.
- **Date:** 2026-10-22
- **Builds on:** [ADR-0009](0009-host-run-loop-invariants.md) (with its 2026-10-22
  amendment), [ADR-0010](0010-approvals-and-delegation.md),
  [ADR-0011](0011-run-log-and-state-store.md),
  [ADR-0012](0012-ai-sdk-loop-mastra-memory-library.md),
  [ADR-0017](0017-cli-first-agent-host.md),
  [ADR-0024](0024-effect-adoption-service-and-rpc-boundaries.md)
- **Scope:** who may ask a person a question, agent-to-agent messaging, peer sessions,
  worktree binding, and a network listener. A security review comes before any listener
  ships.

## Context

The owner's direction: Brainstrike's agents should work the way Claude Code does, including
its first-class messaging. A2A, MCP Tasks, AG-UI and ACP are wire protocols at the boundaries,
not the design.

### Delegation today

A child is an ordinary host run in its own child thread, on its parent's host
([subagent contract](../agents/assistant-subagents.md)).

- **Dispatch:** the model calls `agent-<persona>`; Core runs `HostChildRuns.delegate`
  (`packages/agent-host/src/core-child-runs.ts`).
- **One transaction:** the parent's `effect.started`, the child's `thread.started` (with
  `origin`) and its first `run.started` commit together.
- **Context:** fresh. Persona instructions, child context and the prompt; never the parent's
  history.
- **Admission by reference:** same `LanguageModel`, parent executors narrowed by persona, same
  memory owner and workspace binding (`deriveHostChildAdmission`).
- **Foreground / background:** root delegations default to background; a child's own
  delegations are foreground. Foreground `join` waits on the child's `run.finished`.
- **Background delivery (B10/B14):** a settled child reaches its parent as a `run.started`
  `delivery` behind a durable watermark.
  - As a wake when the parent is idle, or ahead of the next user turn.
  - The delivery is the turn's ledger (`describeHostChildLedger`), marked automated. Only
    `HostChildResult.text` reaches the parent's model.
- **Follow-ups (BST-2178):** a person can type into a child (`run/input` or `run/start`).
- **Approvals:** committed in the child's log; surfaced as `needs-input` in the sidebar and in
  the tree approvals list (`apps/desktop/src/renderer/host-tree-approvals.ts`), which reads
  Core's folded summary of the tree (`thread/tree`), never the children's logs. The root's
  policy governs the tree.
- **Questions:** the built-in `worker` persona admitted `*`, so a child could call `askUser`
  (removed by step 2).
- **Limits:** `maxInvocations`, `maxDepth`, a per-turn work queue, the persona step budget, the
  child's own watchdog and an optional per-leg `maxChildRuntimeMs`. The parent's watchdog never
  judges a running delegation (ADR-0009 amendment, PR #4142).
- **Worktrees:** nothing bound a thread to a worktree it created. In the crashed thread behind
  the ADR-0009 amendment, the root created a worktree, could not open it, archived it, ran
  `git switch` in the person's primary checkout, and both workers edited that checkout (debug
  pack seq 625, 674, 772, 901).
- **Missing:** the model cannot message or continue a child; no peer messaging, peer sessions,
  agent directory or cross-host child.

### What keeps a child on its parent's host

- One transaction for origin, effect and first run: each host writes its own log (ADR-0011).
- Admission by reference: model instances, executors and credentials are process-local.
- Settlement by local fold and stop by `AbortSignal`: neither crosses a process.
- The turn's work queue and root grants live in memory.
- The child edits through the parent's workspace binding.
- `thread/children` and `log/subscribe` read the parent host's log.

## The model: Claude Code (checked 2026-10-22)

From code.claude.com (see Sources); *(observed)* marks behaviour seen only in the desktop app's
session tools.

- **Subagents** are workers inside one session.
  - Background by default; the result arrives as an automated completion notification.
  - Fresh (task message only) or fork (whole conversation). Only the final result returns.
  - Continued with `SendMessage` by name, history intact.
  - Permission prompts surface in the main session, named by the subagent. Subagents cannot
    use `AskUserQuestion`.
  - Nest up to three layers; `isolation: worktree` gives a subagent its own worktree.
  - `maxTurns` caps turns; concurrency defaults to 20; no time limit.
- **Sessions** are peers.
  - Own context, permission mode and usually worktree.
  - Started as `user_asked`, `offer` or `own_initiative` (a proposal the person starts)
    *(observed)*.
  - The starter gets a note quoting the child's latest report each turn, and a wake when idle
    and no started session is working. A note is not proof *(observed)*.
- **Messaging.**
  - `ListAgents` lists subagents, teammates, local, cloud and Remote Control sessions, with
    `offline` where relevant.
  - `SendMessage` by name; read between tool calls; an idle receiver starts a turn; replies go
    to the sender.
  - `notify_when_idle` gives one idle notice.
  - Local socket transport; Remote Control for other machines and cloud.
  - The receiver decides each message: deliver, hold for approval, or refuse.
  - Plain text, size-capped, loop-throttled.
- **Authority.** A message never approves a prompt, counts as consent, changes configuration or
  runs commands. Asking a peer to do what was denied is permission laundering.
- **Time.** No parent timer on a child; approval waits are untimed. A child is bounded by its
  turn limits, its own stall watchdog (which excludes its tool waits) and an optional runtime.
- **Orchestration.** Dynamic workflows are opt-in only. Parallel editors get isolated copies or
  disjoint files.
- **UI.** Per-session task lists; started sessions listed under their starter; background work
  listed with state.

## Decision (proposed)

Brainstrike adopts this model on its own host protocol, with standards at the boundaries.

### Vocabulary

- **Agent:** a thread plus its runs. Status (idle, working, waiting on a person) is derived.
- **Subagent:** a child thread from a delegation; in-process, or remote as an A2A task.
- **Session:** a root thread started by a person or agent and linked to its starter, with its
  own permission state and worktree.
- **Message:** agent-to-agent text, committed in the receiver's log as agent-authored.
- **Note:** the report a child's ended run delivers to its starter.
- **Wake:** the starter's next run, when it is idle with undelivered notes.

### Gaps against Claude Code

- Already matching: background subagents and notifications, fresh context, permission prompts
  named by child, notes and wake for subagents, child-owned limits, depth limit, message-as-data
  structure.
- **Forked subagent:** missing. Add a `fork` option later (decision 6).
- **Continue / message a child from the model:** people only today. Add a `message` tool
  (step 4).
- **Children asking the person:** matches. Children have no `askUser` or `submitPlan`
  (decision 1, step 2).
- **Worktree isolation:** partial. Bind created worktrees; give writers their own (decision 7,
  steps 3 and 6).
- **Sessions:** missing. `session/start`, only on the person's request or proposal (decision 2,
  step 6).
- **Directory, sibling messages, idle notice:** missing or partial. `agents/list`,
  `agents/message`, `agents/notify` (decision 3, step 5).
- **Inbound controls:** missing. A host-level setting (step 7).
- **Workflows:** not adopted.
- **Task lists:** a session is a root, so it has its own; subagents still get none.

### Rules

1. **Questions go up; approvals go to a person.**
   - A child's question goes to its parent agent, which decides or asks the person.
   - A child's permission prompt goes to a person, named by the child.
   - No agent ever answers an approval.
2. **A message is data.** Committed with its sender's address as agent-authored. It never
   answers an interaction, grants permission or changes configuration. No permission laundering.
3. **The parent never times a child.** The running host sets its step budget, watchdog and
   optional `maxChildRuntimeMs`.
4. **One writer per fact.** The host running an agent writes its runs. A starter records only
   its delegation or session start, the remote reference, and notes it delivered.
5. **Writers do not share files.**
   - A session always gets its own worktree.
   - A worker gets one whenever another writer is live in the tree.
   - Creating a worktree binds the thread or delegation that made it.
   - An agent never switches the branch of the person's own checkout.
6. **Status is derived** from runs or remote task state; never stored.
7. **A person starts every session**, directly or by starting a proposal.
8. **Siblings message through the directory**, after parent↔child messaging lands.

### Cross-host addressing

- **Host ID:** minted once per data root and kept in its state DB, plus a display name.
  (`host.json` identifies a process, not a host.)
- **Agent address:**
  - Canonical: `{hostId, threadId}`, written `brainstrike://<hostId>/threads/<threadId>`.
  - Display: `<name>@<host>`. A child's name is its call sign (e.g. `Cedar-3fa9c1`); a
    session's is its title, unique per host.
  - Third-party A2A agent: Agent Card URL + `contextId`.
- **Resolution:** bare name if exactly one live match, else `@<host>`, else canonical.
- **Directory:** `agents/list` returns name, kind, status, starter and address. Clients merge
  hosts; hosts also list remote agents they started; unreachable agents show `offline`.
- **New host methods:**
  - `agents/message {to, text, notifyWhenIdle?}`; the model's `message` tool uses the same
    Core path.
  - `agents/notify {to}`: one idle notice.
  - `session/start {prompt, host?, worktree?, initiation}`.
- **Delivery:** a working agent takes a message at its next step boundary (like `run/input`);
  an idle one starts a run; replies go to `from`.
- **Across hosts:**
  - A message is an A2A `SendMessage` whose `contextId` is the receiver's thread; the reply
    address rides in extension metadata.
  - `agents/notify` is a `SubscribeToTask` ending at the next terminal state.
  - A host that cannot reach the sender keeps its reply; the sender fetches it with `GetTask`.
- **Inbound controls:** accept, hold or refuse per host; cross-person or cross-host messages
  hold by default. A message never carries a grant.
- **A2A listener** (decision 5): off on desktop, on for the cloud host, CLI only when explicitly
  served. Bearer token for loopback CLI-to-CLI; OAuth 2.1 client credentials for cloud.

### Wire protocols

- **Host ↔ client:** the Brainstrike JSON-RPC 2.0 host protocol (ADR-0017, ADR-0024). Gains
  `agents/*` and `session/start`.
- **Host ↔ host and third-party agents:** A2A v1.0.
- **Agent ↔ tool:** MCP, with `io.modelcontextprotocol/tasks` for long calls. Unchanged.
- **Delegation ↔ AI SDK loop:** the AI SDK subagent pattern (preliminary results,
  `toModelOutput`, abort).
- **Later, separate decisions:** AG-UI for third-party web UIs, ACP for editors.

### A2A mapping

- Agent Card: personas as `skills`, endpoint, security schemes, Brainstrike extension. Derived.
- `contextId` = the agent's thread; `taskId` = one run (`referenceTaskIds` link follow-ups).
- `messageId`: derived from the sender's committed call, like a `commandId`.
- States:
  - `WORKING` = run with nothing pending.
  - `INPUT_REQUIRED` = pending approval (or a third-party question).
  - `AUTH_REQUIRED` = a sign-in the child's host cannot finish.
  - `COMPLETED` / `FAILED` / `CANCELED` / `REJECTED` = completed / failed or interrupted /
    stopped / refused before admission.
- `CancelTask` = `run/stop`.
- Extension metadata carries starter address, `toolCallId`, depth, `maxDepth` and permission
  ceiling.
- Host wire names (`HostChildStatus`, `HostChildResult`) stay; the mapping lives in the adapter.

### Approvals and questions across hosts

- **In-process:** unchanged, except children lose `askUser` and `submitPlan`.
- **Remote subagent approval:**
  1. The child's host commits `interaction.requested` and moves the task to input-required,
     with `interactionId`, `toolCallId`, tool, risk, target root and an input digest.
  2. The starter's host relays it without committing; the UI shows it named by the child.
  3. A person answers; the starter forwards under that person's command identity; the child's
     host checks ID and digest. First answer wins (ADR-0010).
  4. Grants apply only on the child's host. The starter never answers from its own policy.
- **Remote session approval:** shown in that session's view; the starter hears only notes.
- **Third-party input-required:** the starter's agent treats it as a question (rule 1).
- **Auth-required:** the person signs in on the child's side; no credential crosses hosts.
- **Ceilings:** the delegation carries the starter's ceiling; the child host intersects and never
  widens it (`intersectChildPermissionCeilings`).
- **Restart:**
  - A served task's pending approval survives its host's restart (ADR-0010).
  - A foreground remote delegation is interrupted and its task cancelled if the starter
    restarts.
  - A background remote child is re-attached from `child.task.bound` (decision 4).

### Who owns each fact

- Delegation call/result, session start: starter's host, starter's log.
- In-process child origin and runs: that host, one transaction (unchanged).
- Remote agent reference: starter's log, new `child.task.bound` (shaped like `mcp.task.bound`).
- Remote agent runs, transcript, approvals, grants: the agent's host.
- Who started a served agent: its `thread.started` with a remote `origin`.
- A message and any hold on it: receiver's log; the sender logs only its send effect.
- Notes: a `notice.posted` on the starter's log, committed with the child run's end (step 3b).
  Which notices a run took: that run's `run.started` `delivery`, read along its branch.
- Status and directory: derived.
- Host ID: minted once in the state DB.
- Root policy and grants: the root host only.
- Credentials: each host's secret store.
- Remote workspace changes: the agent's own worktree, returned as a branch or patch.

## Considered options

1. **A2A as the design.** Rejected as the core: no messaging between running agents, directory,
   parent-routed questions or idle notice. Kept as the host↔host wire.
2. **Agent as an MCP tool with Tasks.** Rejected: MCP is agent↔tool, with no conversation
   identity, directory or messaging.
3. **Replace the host protocol with A2A, AG-UI or ACP.** Rejected: none carries log replay,
   command identities, thread management, workspace binding or rewind.
4. **Claude Code's model on the host protocol, standards at the boundaries.** Chosen: most pieces
   exist, the rest are owned additions. Costs: new methods and a tool, peer sessions, and a
   network listener.

## What changes first

0. **Done:** watchdog fix, PR #4142 (`62d6ee36e`).
1. **Done:** owner decisions (2026-10-22).
2. **Done: questions go up, by removal.** Drop `askUser` and `submitPlan` from child admission (as
   `manageTaskList` already is in `narrowHostChildTools`); update the worker persona.
3. **A created worktree binds its thread** or the delegation that made it. No agent switches the
   person's checkout. A worker delegated beside another live writer gets its own worktree.
3b. **One notice** (owner decision 2026-11-05, from the agent messaging audit). Everything a
   thread is told that no person typed is one notice on that thread's log, posted by the
   commit that settles it and taken by the run or step that delivers it, along that run's own
   branch. opencode ships this shape (a pending inbox row taken in the message's own
   transaction); Claude Code reads incoming messages between tool calls; AI SDK 7 carries
   messages `prepareStep` returns into later steps.
   - **Done:** a child run's report and a command session's exit. The child's terminal commit
     posts the report on its parent's log in the same transaction, so whether it reports is
     decided once and the report outlives the child thread. An exit is posted on the thread
     that hears it and survives a restart. A run takes the notices due on its branch: not yet
     taken there, and, for a child's report, dispatched there. This removed the
     process-global delivered set and the process-local exits queue.
   - **Done:** a running thread takes its due notices at its next step boundary in
     `prepareStep` (`steer`): one user message, committed as `model.messages` whose `delivery`
     names them, so the branch counts them taken. An idle thread wakes, or its next run takes
     them (`queue`). A turn's input is its first user message by identity
     (`turn-input.ts`), not the last user message by role.
   - **Done:** a person's input (`run/input`) is a notice: its committed command. A working run
     reads it at its next step, as its own user message, so an awaited child's answer to it is
     its parent's tool result; an idle thread, decided in commit order, starts the person's turn
     with it. This removed "end the run, then start the next one" (`child-input.ts`). The read
     message passes its UserPromptSubmit hooks, mentioned files and skills, as a prompt does.
   - **Done:** the composer's Steer sends `run/input` on every thread, so the run reads the
     message at its next step and no run ends early to make room for it. This removed
     `run/steer`. Step 4's `message` tool and step 5's `agents/notify` then post notices.
4. **The `message` tool**, addressing children by call sign: follow-up run if idle, `run/input`
   if working. Committed as agent-authored.
5. **Directory on one host:** `agents/list`, `agents/message`, `agents/notify`; the sidebar reads
   it. Sibling messages after step 4.
6. **Sessions on one host:** `session/start` in its own worktree, linked to its starter, only on
   the person's request or proposal. Notes and wake reuse delivery.
7. **Inbound controls and host ID**, before anything leaves the host.
8. **Across hosts via A2A:** security review; serve from an explicitly started CLI host with a
   loopback bearer token (A2A TCK); outbound delegation and messaging; approval relay and
   re-attach.
9. **Cloud host** with OAuth 2.1 client credentials (own ADR).
10. **`fork` context.** Nothing earlier depends on it.

## Consequences

- Host protocol version bump: `agents/*`, `session/start`, agent-authored message event,
  `child.task.bound`, remote `origin`, inbound setting.
- Children can no longer ask the person; delegated work may take an extra round through the
  parent.
- A created worktree moves its thread's binding (Changes review and tool roots follow).
  Parallel workers cost disk and a merge back.
- A network listener needs a security review before shipping.
- A remote agent cannot edit the starter's tree; it uses its own host's model and usage ledger.
- Unchanged: in-process delegation and restart rules (ADR-0010), the AI SDK loop (ADR-0012),
  MCP, the client transport (ADR-0024).

## Owner decisions (2026-10-22)

The owner adopted the recommended answer to every question.

1. **Questions go up.** Children lose `askUser` and `submitPlan`.
2. **Peer sessions** start only on the person's request or from a proposal they start.
3. **Sibling messaging:** yes, via the directory, after parent↔child messaging. Messages are
   data.
4. **Background remote child across a starter restart:** re-attach and deliver.
5. **Listener:** off on desktop, on for cloud, CLI only when served; bearer token on loopback,
   OAuth 2.1 for cloud; security review first.
6. **Fork context:** offer later.
7. **Worktrees:** sessions always get one; workers get one when another writer is live; creating
   one binds its thread or delegation; never switch the person's checkout.

## Sources

- **Claude Code docs** (read 2026-10-22):
  - <https://code.claude.com/docs/en/sub-agents>
  - <https://code.claude.com/docs/en/cross-session-messaging>
  - <https://code.claude.com/docs/en/agent-teams>
  - <https://code.claude.com/docs/en/agents>
  - <https://code.claude.com/docs/en/workflows>
  - <https://code.claude.com/docs/en/desktop>
  - *(observed)* items: the desktop app's session tools, 2026-10-22.
- **Standards** (checked 2026-10-22):
  - A2A v1.0.1: <https://a2a-protocol.org/latest/specification/>,
    <https://github.com/a2aproject/A2A/blob/v1.0.1/specification/a2a.proto>, extensions
    <https://a2a-protocol.org/latest/topics/extensions/>, §7.6.4
    <https://github.com/a2aproject/A2A/pull/2081>, `@a2a-js/sdk` 1.3.0, TCK
    <https://github.com/a2aproject/a2a-tck>.
  - MCP 2026-07-28 with Tasks as `io.modelcontextprotocol/tasks` (SEP-2663):
    <https://modelcontextprotocol.io/specification/2026-07-28/changelog>,
    <https://github.com/modelcontextprotocol/ext-tasks>. `@brainstrike/mcp-tasks-extension`
    pins ext-tasks `0d0a6bd`.
  - AI SDK 7.0.142 subagents: <https://ai-sdk.dev/docs/agents/subagents> (vercel/ai #18143,
    #8380).
  - AG-UI 1.0.3: <https://docs.ag-ui.com/concepts/subagents>,
    <https://docs.ag-ui.com/concepts/interrupts>.
  - ACP schema v1.26.0: <https://agentclientprotocol.com/protocol/tool-calls>.
- **Code** at `fc87801f4`: `packages/agent-host/src/{core-child-runs,child-runs,child-presentation,protocol,ports}.ts`,
  `packages/assistant-contract/src/personas.ts`,
  `apps/desktop/src/renderer/host-tree-approvals.ts`,
  `packages/app-shell/src/host-child-sidebar-cell.tsx`.
