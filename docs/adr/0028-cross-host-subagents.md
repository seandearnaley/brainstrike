# ADR-0028: Subagents, sessions and agent messaging work as Claude Code does, across hosts

- **Status:** Proposed (draft for owner review; revised 2026-10-22 to the owner's
  direction)
- **Date:** 2026-10-22
- **Ticket:** none yet
- **Builds on:** [ADR-0009](0009-host-run-loop-invariants.md) with its 2026-10-22
  amendment, [ADR-0010](0010-approvals-and-delegation.md),
  [ADR-0011](0011-run-log-and-state-store.md),
  [ADR-0012](0012-ai-sdk-loop-mastra-memory-library.md),
  [ADR-0017](0017-cli-first-agent-host.md),
  [ADR-0024](0024-effect-adoption-service-and-rpc-boundaries.md)
- **Needs owner discussion before any implementation:** it changes who may ask a person
  a question, adds agent-to-agent messaging and peer sessions, and adds a network-facing
  server to the host (AGENTS.md: ownership and engine changes).

## Context

The owner's direction, given while reviewing the first draft of this ADR: Brainstrike's
agents should "mimic the way you work by and large", meaning Claude Code, which has "a
first class implementation of messaging". The first draft made A2A the design. This
revision makes Claude Code's model the design. A2A, MCP Tasks, AG-UI and ACP are the
wire protocols it maps onto at its boundaries.

### Delegation today

A child is an ordinary host run in its own child thread, on its parent's host
([subagent contract](../agents/assistant-subagents.md)).

- **Dispatch.** The model calls `agent-<persona>`. Core dispatches the call
  (`executeHostAction` → `HostChildRuns.delegate`,
  `packages/agent-host/src/core-child-runs.ts:522`).
- **One transaction.** The parent's `effect.started`, the child's `thread.started` with
  its `origin`, and the child's first `run.started` commit together (`prepare`).
- **Context.** The child starts fresh. It receives its persona instructions, the host's
  child context and the delegated prompt, never the parent's history.
- **Admission by reference.** The child's admission is derived in memory from the
  parent's: the same `LanguageModel` instance, the parent's executors narrowed by
  persona, and the same memory owner and workspace binding (`deriveHostChildAdmission`).
- **Foreground and background.** A root delegation runs in the background unless the
  model opts out; a child's own delegations run in the foreground. A foreground `join`
  waits on the child's committed `run.finished`, and the parent's abort stops the child.
- **Background delivery (B10/B14).** A settled background child reaches its parent as a
  `run.started` `delivery`, behind a durable watermark. The delivery comes either:
  - as a **wake**, when the parent's thread is idle (`wakeParams`); or
  - ahead of the next user turn.

  The delivered message is the whole turn's ledger of background invocations
  (`describeHostChildLedger`), marked as automated text the user did not write. Only
  `HostChildResult.text` reaches the parent's model (`toModelOutput`).
- **Follow-ups (BST-2178).** A *person* can type into a child. `run/input` ends a working
  child's run after its current step and starts the next run with the input. A
  `run/start` on an idle child starts a follow-up run. Work that took human input
  reports to the parent in the same delivery.
- **Approvals.** A child's `interaction.requested` is committed in the child's own log.
  - The parent's sidebar shows the child as `needs-input` (`thread/children/changed`,
    `host-child-sidebar-cell.tsx`).
  - The desktop lists every approval waiting anywhere in the viewed thread's tree,
    named by its child (`apps/desktop/src/renderer/host-tree-approvals.ts`).
  - A client answers with `interaction/respond`.
  - The root's live policy governs the tree, and `releaseGranted` answers asks that a
    new grant allows.
- **Questions.** The built-in `worker` persona admits `*`, which includes `askUser`. A
  child can therefore ask the person a question directly.
- **Limits.** These all exist today:
  - `maxInvocations` per turn and `maxDepth`;
  - one in-memory work queue per root turn;
  - the persona's step budget, whose last step is a tool-free summary;
  - the child's own watchdog;
  - an optional `maxChildRuntimeMs`, armed per execution leg, so that it never runs
    while a person decides.

  Since ADR-0009's 2026-10-22 amendment (PR #4142), the parent's watchdog never judges
  a running delegation.
- **What is missing:**
  - The parent's *model* cannot message a child, continue a finished one, or hear from
    a working one.
  - No agent can message a peer.
  - There is no peer session, no agent directory and no cross-host child.

### What keeps a child on its parent's host

| Today's mechanism | Why it cannot cross a host |
| --- | --- |
| Origin, effect and first run in one transaction | Each host writes its own log (ADR-0011); no transaction spans two |
| Admission by reference | Model instances, executors and credentials are process-local by contract (`hostRunSnapshotSchema`) |
| Settlement by local fold; stop by `AbortSignal` | Neither a promise nor a signal crosses a process |
| The turn's work queue and the root's grants | In memory |
| The workspace | The child edits through the parent's binding and filesystem |
| A client's view of a child | `thread/children` and `log/subscribe` read the parent host's log |

## The model: how Claude Code works (checked 2026-10-22)

The facts below come from code.claude.com, as cited in Sources. Some details are only
observable in the desktop app's own session tools; those are marked *(observed)*.

**Subagents** are workers inside one session.

- **Background by default.** A subagent spawned from the main conversation runs in the
  background. Its result arrives as a completion notification in a later turn, marked as
  an automated event. The parent waits for that notification and does not poll.
- **Fresh or fork.**
  - A fresh subagent sees only the task message the parent writes, plus project context.
  - A fork inherits the whole conversation.

  Either way, the subagent's own tool calls stay out of the parent's context, and only
  its final result returns.
- **Continuable.** A finished subagent is continued with `SendMessage` by name or ID,
  with its full history intact.
- **Approvals and questions.** A background subagent's permission prompts surface in the
  main session, named by the subagent. Escape denies one call without stopping the
  subagent. Subagents cannot use `AskUserQuestion`.
- **Nesting.** Subagents nest up to three layers below the main conversation.
- **Worktrees.** `isolation: worktree` gives a subagent its own git worktree.
- **Limits.** `maxTurns` caps a subagent's turns, and its output is then marked partial
  and can be resumed. Concurrency is capped (20 by default). The docs give no time limit.

**Sessions** are peer agents.

- **Isolation.** Each session has its own context, its own permission mode and,
  usually, its own worktree.
- **Starting.** In the desktop app, a session suggests a task as a card the person can
  Start or Do here. A started session is listed under the session that started it.
- **Hearing back** *(observed)*:
  - The starter receives a note that quotes the child session's latest report each
    time that session ends a turn.
  - The starter is woken when it is idle and none of the sessions it started is still
    working.
  - A note is a report, not proof: the starter checks the result before calling it done.
- **Who starts it** *(observed)*. A session starts as `user_asked`, `offer`, or
  `own_initiative`. `own_initiative` is a proposal that the person starts.

**Messaging** is first class.

- **Listing.** `ListAgents` lists every reachable agent: subagents, teammates, other
  local sessions, cloud sessions and Remote Control sessions on other machines. A row
  can show the agent as `offline` or unable to receive.
- **Sending.** `SendMessage` is addressed by name. A short ref is added only when a name
  is ambiguous.
- **Delivery.** A message is read between tool calls, so a running tool is never
  interrupted. An idle receiver starts a new turn with it. A reply goes to the sender's
  address. A cloud session receives messages but cannot reply yet.
- **Idle notices.** `notify_when_idle` asks for one notice when a session next goes idle
  or exits, with no polling.
- **Transport.** Same-machine messages travel over a per-session socket. Messages to
  other machines and cloud sessions travel through Anthropic's servers over Remote
  Control.
- **Inbound controls.** The receiving session decides each message: deliver, hold for
  its user's approval, or refuse. Its default depends on the two sessions' permission
  modes.
- **Limits.** Messages are plain text only. Sizes are capped and bursts and loops are
  throttled.

**Authority.**

- A message from another agent can never approve a permission prompt or count as the
  user's consent. It cannot change configuration, and its commands do not run. The
  receiver's own permission prompts still fire.
- An agent never asks a peer to do what was denied in its own session. That would be
  permission laundering.

**Time.** No parent timer runs on a child, and an approval wait is never timed. A child
is bounded by:

- its turn and step limits;
- its own stall watchdog, which does not count time spent waiting on the agent's own
  tool calls (the workflows page, "When an agent stalls");
- an optional runtime setting.

**Orchestration.** A dynamic workflow runs many subagents from a script, using
`agent()`, `parallel()`, `pipeline()` and `phase()`. It runs only when the person opts
in: the `ultracode` keyword, a direct request in a prompt they typed, or the ultracode
setting. Agents that edit in parallel each work in their own isolated copy. Where they
share a checkout, the work is partitioned so that no two agents edit the same files.

**UI.**

- Each session keeps its own task list *(observed)*.
- Sessions a session started are listed under it.
- Background work is listed (`/tasks`, agent view) with its state, including whether
  it needs the person *(observed: working, idle, waiting on the user)*.

## Decision (proposed)

Brainstrike adopts this model. The host's existing pieces carry most of it. The
standards sit underneath, at the boundaries.

### Vocabulary

- **Agent.** A thread together with its runs. A thread is idle, working, or waiting on a
  person; that status is always derived, never stored.
- **Subagent.** A child thread created by a delegation. It runs in-process on its
  parent's host, or remotely as an A2A task (see below).
- **Session.** A root thread started by a person or by an agent and linked to its
  starter. It has its own permission state and its own worktree.
- **Message.** Text from one agent to another. It is committed in the receiver's log as
  agent-authored, never as the user's message.
- **Note.** The report a child's ended run delivers to its starter.
- **Wake.** The starter's next run, which begins when the starter is idle and has
  undelivered notes.

### How the model maps onto Brainstrike

| Claude Code | Brainstrike today | Status | Change |
| --- | --- | --- | --- |
| Background subagent; completion notification; only the conclusion enters context | Root delegation is background by default; B10/B14 wake delivery of the whole-turn ledger; `toModelOutput` passes only the text | Exists | None |
| Fresh subagent | Children start from the brief and persona only | Exists | None |
| Forked subagent | — | Missing | A `fork` delegation option that starts the child from the parent's committed messages (later) |
| Continue a finished subagent by name with `SendMessage` | BST-2178 follow-ups, but only a person can type them | Partial | A `message` tool for the model (step 3) |
| Message a working agent; it reads it at its next tool round | `run/input` ends the child's run after its current step and starts the next run with the input | Exists for people | The same path, opened to agents (step 3) |
| Subagent permission prompts surface in the main session, named by the subagent | `interaction.requested` in the child's log; tree approvals named by call sign; `needs-input` in the sidebar | Exists | None in-process. Cross-host: relay (below) |
| Subagents cannot ask the user; questions go to the parent | Children with `askUser` ask the person directly | Differs | Remove `askUser` and `submitPlan` from child admission (step 2) |
| Note per ended turn; wake when idle; a note is not proof | Delivery entries; the wake; ledger text that says starting work never proves completion | Exists for subagents | The same path for sessions (step 5) |
| The child ledger / "linked sessions" | `describeHostChildLedger`; `thread/children`, with a call sign, colour and status | Exists for children | Generalised by the directory (step 4) |
| Parent never times a child; approvals never time out; the child's own limits | `maxChildRuntimeMs` per leg (optional), step budget, the child's own watchdog, ADR-0009 amendment | Exists | None. Remote children keep their host's limits |
| Nesting depth limit | `maxDepth`; only workers delegate | Exists | None |
| Worktree isolation for a writer | Children share the parent's workspace binding; worktrees exist for threads (`worktree.created`, thread binding) | Partial | Optional worktree per delegation; a session gets its own by default (step 5) |
| Sessions: `user_asked`, `offer`, `own_initiative` proposal cards | — | Missing | `session/start` plus a proposal interaction (step 5) |
| `ListAgents`, with busy/idle state | `thread/list`, `thread/children`, derived `hostChildStatus` | Partial | `agents/list` across the tree and peers (step 4) |
| `SendMessage` by name; reply to `from` | — | Missing | `agents/message` and the `message` tool (steps 3–4) |
| `notify_when_idle` | `thread/children/changed`, which is a re-read hint | Partial | One-shot `agents/notify` (step 4) |
| Inbound controls: accept, hold, refuse | — | Missing | A host-level inbound setting (step 6) |
| A message is data; it cannot approve; no laundering | Only a client's `interaction/respond` answers an interaction; deliveries are marked automated | Exists structurally | Stated as rules below |
| Workflows only on the user's opt-in | — | Not adopted | Out of scope |
| Per-session task list | `manageTaskList` belongs to the root; children do not get it | Differs | A session is a root, so it has its own list. Subagents stay without one |

### Rules

1. **Questions go up; approvals go to a person.**
   - A child's question goes to its parent agent. The parent decides, or asks the
     person itself.
   - A child's permission prompt goes to a person, named by the child that asks.
   - No agent ever answers an approval.
2. **A message is data.** It is committed with its sender's address and marked as
   agent-authored. It can never answer an interaction, grant a permission or change
   configuration. An agent never asks a peer to do what its own policy denied.
3. **The parent never times a child.** A child is bounded by its own step budget, its
   own watchdog and an optional per-leg `maxChildRuntimeMs`, all set by the host that
   runs it.
4. **One writer per fact.** The host that runs an agent writes everything about that
   agent's runs. A starter records only its own facts:
   - its delegation call or session start;
   - the reference to the remote agent;
   - the notes it delivered to its own model.
5. **Writers do not share files.** A child that edits in parallel with another writer
   gets its own worktree. Otherwise the work is partitioned so that no two writers edit
   the same files.
6. **Status is derived.** Idle, working, waiting on a person and offline are computed
   from runs, or from the remote task's state. They are never stored.

### Cross-host addressing

Any client can list and message agents on any host it can reach. A host does the same
for the agents it started.

- **Host identity.** Each data root gets a host ID, minted once by the host that creates
  the root and kept in its state DB. A host also has a display name. Today `host.json`
  identifies a running process, not a host.
- **Agent address.**
  - The canonical form is `{hostId, threadId}`, written `brainstrike://<hostId>/threads/<threadId>`.
  - The display form is `<name>@<host>`. A child's name is its call sign
    (`hostChildCallSign`, such as `Cedar-3fa9c1`). A session's name is its title,
    made unique on its host.
  - A third-party A2A agent is addressed by its Agent Card URL plus its `contextId`.
- **Resolution.** Names resolve as Claude Code resolves them:
  - a bare name is used when exactly one live agent answers to it;
  - otherwise the name takes `@<host>`;
  - if it is still ambiguous, the canonical form is required.
- **Directory.**
  - `agents/list` on a host returns its agents with their name, kind (subagent or
    session), status, starter and address.
  - A client attached to several hosts merges their lists.
  - A host also lists the remote agents it started, with the status their tasks last
    reported.
  - An agent it cannot reach shows as `offline`.
- **Methods on the host client protocol.** All three are new:
  - `agents/message {to, text, notifyWhenIdle?}` sends a message;
  - `agents/notify {to}` asks for one idle notice;
  - `session/start {prompt, host?, worktree?, initiation}` starts a session.

  The model's `message` tool calls the same Core path that `agents/message` does.
- **Delivery.**
  - A message to a working agent is taken at its next step boundary, as `run/input` is
    today.
  - A message to an idle agent starts its next run.
  - A message's own reply goes to its `from` address.
- **Across hosts.**
  - Host to host, and to any third-party agent, a message is an A2A `SendMessage` whose
    `contextId` is the receiver's thread. The sender's address rides in the extension's
    metadata as the reply address.
  - `agents/notify` across hosts is a `SubscribeToTask` that ends at the receiver's
    next terminal state.
  - A host that cannot reach the sender, such as a cloud host replying to a desktop
    behind NAT, keeps its reply in its own log. The sender's host fetches it with
    `GetTask`, and a client can read it by attaching directly. This matches Claude
    Code's cloud sessions, which receive messages but cannot reply.
- **Inbound controls.**
  - Each host has an inbound setting: accept, hold or refuse, with a hold for a message
    that crosses to another person or host by default.
  - A held message waits for the receiving person's approval.
  - A message never carries a grant.

### Wire protocols at the boundaries

| Boundary | Protocol | Role |
| --- | --- | --- |
| Host ↔ client (desktop, CLI, web, cloud) | The Brainstrike host protocol, JSON-RPC 2.0 (ADR-0017, ADR-0024) | Carries the whole model: directory, messages, sessions, approvals. Grows `agents/*` and `session/start` |
| Host ↔ host, and Brainstrike ↔ third-party agents | A2A v1.0 | A remote subagent or remote session is an A2A task; messages and notices map as above |
| Agent ↔ tool | MCP, with `io.modelcontextprotocol/tasks` for long calls | Unchanged |
| Delegation call ↔ AI SDK loop | The AI SDK subagent pattern | For a remote subagent: preliminary results, `toModelOutput`, abort |
| Host ↔ third-party web UI | AG-UI 1.0 (later, its own decision) | `SUBAGENT_*` events map to directory rows; a `tool_call` interrupt maps to an approval |
| Host ↔ editor | ACP (later, its own decision) | `session/request_permission` maps to an approval with its grant |

### A2A mapping for remote subagents and sessions

| A2A | Brainstrike |
| --- | --- |
| Agent Card (`/.well-known/agent-card.json`) | The host's personas as `skills`, its endpoint, security schemes and the Brainstrike extension. Derived, never stored |
| `contextId` | The agent's thread on its host |
| `taskId` | One run. A message on an idle context starts the next run, and its `referenceTaskIds` name the earlier one |
| `messageId` | Derived from the sender's committed tool call or command, as a `commandId` is today. Whether a third-party agent deduplicates is unverified |
| `TASK_STATE_WORKING` | A run with nothing pending |
| `TASK_STATE_INPUT_REQUIRED` | A pending approval, or a pending question in a third-party agent |
| `TASK_STATE_AUTH_REQUIRED` | A sign-in the child's host cannot finish itself |
| `COMPLETED` / `FAILED` / `CANCELED` / `REJECTED` | `completed` (the answer is an artifact; an empty answer reads as `no-answer`) / `failed` or `interrupted` / `stopped` / refused before admission |
| `CancelTask` | `run/stop` |
| No parent/child field | The extension's metadata carries the starter's address, `toolCallId`, depth, `maxDepth` and permission ceiling |

The host's own wire names (`HostChildStatus`, `HostChildResult`) stay as they are. The
mapping lives only in the A2A adapter.

## Approvals and questions across hosts

- **In-process.** Unchanged, except that children lose `askUser` and `submitPlan`
  (rule 1).
- **A remote subagent's approval.** The approval is that host's fact.
  1. The child's host commits `interaction.requested` and moves the task to
     input-required. The status carries a data part under the Brainstrike extension:
     the `interactionId`, `toolCallId`, tool, risk, target root, and a digest of the
     exact input.
  2. The starter's host relays it as a preliminary result and a directory status
     change. It commits nothing. The parent's UI shows it named by the child, as tree
     approvals do today.
  3. A person answers. The starter's host forwards the answer to the task under that
     person's command identity, and the child's host checks the `interactionId` and the
     input digest before it commits. A client attached directly to the child's host may
     answer there instead; the first answer commits and a second is refused (ADR-0010).
  4. A grant given with an answer applies only on the child's host. The starter's host
     never answers a remote ask from its own policy: a remote agent is in its own
     permission domain, as a Claude Code session is.
- **A remote session's approval.** It surfaces in that session's own view, which any
  client reaches through the directory with a `waiting on a person` status. Its starter
  hears only notes.
- **A third-party agent's input-required.** The starter's agent treats it as that
  child's question (rule 1): it decides, or asks the person, and replies with a message.
  The person's answer is never relayed as the parent's own decision.
- **Auth-required.** The person signs in on the child's host or service. No credential
  crosses a host.
- **Ceilings.** The delegation carries the starter's ceiling: allow, ask or deny per risk
  category, plus the admitted tool IDs. A Brainstrike child's host intersects it with its
  own policy and never widens it (`intersectChildPermissionCeilings`).
- **Restart.**
  - A served task is a top-level run on its own host, so under ADR-0010 its pending
    approval survives that host's restart.
  - When the starter's host restarts, a foreground remote delegation is interrupted and
    its bound task is cancelled.
  - What happens to background ones is open question 4.

## Who owns each fact

| Fact | Writer | Where it lives |
| --- | --- | --- |
| A delegation call and its result; a session start | Starter's host | Starter's log (`effect.started`, `effect.finished`, a session-start effect) |
| An in-process child's origin and runs | That host | Its log, in one transaction (unchanged) |
| The reference to a remote agent (address, context ID, task ID) | Starter's host | Starter's log: a new `child.task.bound`, shaped like `mcp.task.bound` |
| A remote agent's runs, transcript, approvals, answers and grants | Agent's host | Agent's log |
| Who started a served agent | Agent's host | Its `thread.started`, with a remote `origin` |
| A message | Receiver's host | Receiver's log, as agent-authored input with its `from` address. The sender's log records only its own send effect |
| A held inbound message, and its approval | Receiver's host | Receiver's log |
| Notes delivered to a model, and the watermark | Starter's host | `run.started` `delivery` (unchanged) |
| Agent status and the directory | Nobody: derived | Computed from runs or remote task state |
| Host ID | The host that creates the data root | Its state DB, minted once |
| Root policy and its grants | Root host's policy owner | The root host. It never answers for another host |
| Credentials | Each host's platform secret store | That host only |
| A remote agent's workspace changes | Agent's host | Its own worktree; returned as a branch or patch |

## Considered options

1. **A2A as the design** (the first draft). Every child is an A2A task first.
   - For: one standard everywhere.
   - Against: A2A has no messaging between running agents, no directory, no questions
     routed to a parent and no idle notice. The host would still need all of these, and
     in-process children would carry a wire vocabulary they do not need.
   - Demoted: A2A is the host↔host and third-party wire.
2. **The agent as an MCP tool, using Tasks.**
   - For: it reuses the MCP Tasks client.
   - Against: MCP is agent↔tool. It has no conversation identity, no directory, no
     messaging, and no stable agent pattern; its Agents interest group is still
     evaluating one.
   - Rejected.
3. **Replace the host protocol with A2A, AG-UI or ACP.**
   - Against: none of them carries durable log replay, command identities, thread
     management, workspace binding or rewind (ADR-0024).
   - Rejected. AG-UI and ACP adapters are later decisions.
4. **Claude Code's model on the host protocol, with the standards at the boundaries.**
   Chosen.
   - For: most of it exists already (background delegation, wake delivery, tree
     approvals, call signs, child-owned limits). What is missing is a short list of
     additions with one owner each. It is the behaviour the owner works with every day.
   - Against:
     - New methods and a new tool.
     - Peer sessions are a new concept.
     - Cross-host messaging needs a network listener.

## What changes first

0. **Prerequisite:** land the watchdog fix (PR #4142,
   `claude/thread-crash-debug-fd9a22`).
1. **Owner decisions** on the open questions. No code until then.
2. **Questions go up, by removal.** Drop `askUser` and `submitPlan` from child admission,
   as `manageTaskList` already is (`narrowHostChildTools`). A child that needs a
   decision ends its run with the question in its report, and the parent decides or
   asks the person. Update the worker persona's instructions to match.
3. **The `message` tool.** It addresses the parent's children by call sign.
   - To an idle child, the message starts a follow-up run.
   - To a working child, it is `run/input`.

   Both paths exist today for people (BST-2178), and the result returns through the
   existing delivery. The message is committed as agent-authored.
4. **The directory on one host:** `agents/list`, `agents/message` and a one-shot
   `agents/notify`, derived from runs and `thread/children`. The desktop sidebar reads
   it.
5. **Sessions on one host:**
   - `session/start`, which creates a root thread with its own worktree, linked to its
     starter;
   - `user_asked` and `offer` starts, and an `own_initiative` proposal as an interaction
     the person starts;
   - notes and the wake reuse the delivery path.
6. **Inbound controls and the host ID**, before anything leaves the host.
7. **Across hosts, through A2A:**
   - first serve A2A from the CLI host, proven with the A2A TCK;
   - then delegate and message outbound, proven CLI host to CLI host on loopback;
   - then relay approvals.
8. **The cloud host** (its own ADR).

## Consequences

- **Protocol bump.** The host protocol version bumps for:
  - `agents/*`;
  - `session/start`;
  - an agent-authored message event;
  - `child.task.bound`;
  - a remote `origin` on `thread.started`;
  - the inbound setting.
- **Children can no longer ask the person.** A worker that needs a decision stops and
  reports, so delegated work may take an extra round through the parent.
- **Security.** A network listener and a new client origin need a security review. The
  desktop keeps the listener off by default.
- **Remote agents.** A remote agent cannot edit the starter's working tree. It runs its
  own host's model, and its usage stays on that host's ledger.
- **Unchanged:**
  - in-process delegation mechanics and their restart rules (ADR-0010);
  - the AI SDK loop (ADR-0012);
  - MCP;
  - the client protocol's transport (ADR-0024).

## Open questions for the owner

1. **Questions.** Should children lose `askUser` and `submitPlan`, so that their
   questions route through the parent as in Claude Code? Recommended: yes. It is a
   removal.
2. **Peer sessions.** Should an agent be able to start one (`session/start`) on its own
   initiative, only as a proposal the person starts? Or only when the person asks?
   Recommended: proposals plus person-asked starts, as in Claude Code.
3. **Messaging between siblings.** Should children of one parent message each other by
   name, as named Claude Code subagents can? Or only their parent?
4. **A background remote child across a starter restart.** Re-attach and deliver its
   result, or cancel it as an in-process child is interrupted?
5. **The listener and its authentication.** Is A2A on by default for CLI and cloud and
   off for desktop? Which authentication: a bearer token, OAuth 2.1 client credentials,
   or mTLS?
6. **Fork context.** Should the delegation tool offer `fork`, which gives the child the
   parent's committed messages?
7. **Worktrees.** Does a worker that edits in parallel always get its own worktree? Or
   only when another writer is live in the same tree?

## Sources

**Claude Code** (code.claude.com, read 2026-10-22):

- subagents (background default, fork vs fresh, resume with `SendMessage`, permission
  prompts in the main session, no `AskUserQuestion`, nesting, worktree isolation,
  `maxTurns`): <https://code.claude.com/docs/en/sub-agents>;
- cross-session messaging (`ListAgents`, `SendMessage`, delivery between tool calls,
  `notify_when_idle`, inbound controls, authority rules, cloud replies, transports):
  <https://code.claude.com/docs/en/cross-session-messaging>;
- agent teams (mailbox, idle notifications, teammate prompts in the lead, relayed
  approvals untrusted): <https://code.claude.com/docs/en/agent-teams>;
- running agents in parallel (worktrees, partitioning files):
  <https://code.claude.com/docs/en/agents>;
- dynamic workflows (opt-in, `agent`/`parallel`/`pipeline`/`phase`, isolated copies,
  the stall window excludes tool waits): <https://code.claude.com/docs/en/workflows>;
- desktop (suggested-task cards, started sessions listed under their starter,
  messages held until current work finishes): <https://code.claude.com/docs/en/desktop>.

*(observed)* items come from the Claude Code desktop app's session tools, as the
coordinating session used them on 2026-10-22: notes quoting a session's latest report,
the idle wake, start initiations, and per-session task lists.

**Standards** (checked 2026-10-22):

- **A2A v1.0.1** (2026-05-28; v1.0.0 2026-03-12):
  - <https://a2a-protocol.org/latest/specification/>;
  - <https://github.com/a2aproject/A2A/blob/v1.0.1/specification/a2a.proto> (task states
    `TASK_STATE_*`; RPCs `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`,
    `CancelTask`, `SubscribeToTask`, push configuration, `GetExtendedAgentCard`);
  - extensions (`capabilities.extensions`, the `A2A-Extensions` header):
    <https://a2a-protocol.org/latest/topics/extensions/>;
  - §7.6.4, where auth-required is not a grant: <https://github.com/a2aproject/A2A/pull/2081>;
  - `@a2a-js/sdk` 1.3.0;
  - the TCK: <https://github.com/a2aproject/a2a-tck>.
- **MCP 2026-07-28**, with Tasks as the `io.modelcontextprotocol/tasks` extension
  (SEP-2663: `tasks/get`, `tasks/update`, a cooperative `tasks/cancel`,
  `notifications/tasks`):
  - <https://modelcontextprotocol.io/specification/2026-07-28/changelog>;
  - <https://github.com/modelcontextprotocol/ext-tasks>.

  Brainstrike's `@brainstrike/mcp-tasks-extension` pins it (ext-tasks `0d0a6bd`). The
  official MCP SDK 2.3.1 still carries the 2025-11-25 core Tasks.
- **AI SDK 7.0.142:**
  - subagents (async-generator `execute` with preliminary results, `toModelOutput`,
    `abortSignal`; "Subagent tools cannot use approval flows such as `toolApproval`"):
    <https://ai-sdk.dev/docs/agents/subagents>;
  - open issues: vercel/ai #18143 and #8380.
- **AG-UI 1.0.3:** `SUBAGENT_*` events with `parentToolCallId`; interrupts with
  `reason: "tool_call"`. See <https://docs.ag-ui.com/concepts/subagents> and
  <https://docs.ag-ui.com/concepts/interrupts>.
- **ACP schema v1.26.0:** `session/request_permission` with `allow_once`,
  `allow_always`, `reject_once` and `reject_always`; subagents are in the unstable
  schema only. See <https://agentclientprotocol.com/protocol/tool-calls>.

**Code** at `fc87801f4`:

- `packages/agent-host/src/core-child-runs.ts`;
- `packages/agent-host/src/child-runs.ts`;
- `packages/agent-host/src/child-presentation.ts`;
- `packages/agent-host/src/protocol.ts`;
- `packages/agent-host/src/ports.ts`;
- `packages/assistant-contract/src/personas.ts` (the worker's `*`);
- `apps/desktop/src/renderer/host-tree-approvals.ts`;
- `packages/app-shell/src/host-child-sidebar-cell.tsx`;
- [the subagent contract](../agents/assistant-subagents.md).

The watchdog fix that this ADR assumes is PR #4142 (`claude/thread-crash-debug-fd9a22`).
