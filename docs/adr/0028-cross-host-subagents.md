# ADR-0028: A child run is an A2A task wherever it runs

- **Status:** Proposed (draft for owner review)
- **Date:** 2026-10-22
- **Ticket:** none yet
- **Builds on:** [ADR-0009](0009-host-run-loop-invariants.md) with its 2026-10-22
  amendment, [ADR-0010](0010-approvals-and-delegation.md),
  [ADR-0011](0011-run-log-and-state-store.md),
  [ADR-0012](0012-ai-sdk-loop-mastra-memory-library.md),
  [ADR-0017](0017-cli-first-agent-host.md),
  [ADR-0024](0024-effect-adoption-service-and-rpc-boundaries.md)
- **Needs owner discussion before any implementation:** it decides who owns a child
  that runs on another host, and it adds a network-facing server to the host
  (AGENTS.md: ownership and engine changes).

## Context

### Delegation today

A child is an ordinary host run in its own child thread, on its parent's host
([subagent contract](../agents/assistant-subagents.md)).

- **Dispatch.** The model calls `agent-<persona>`. That tool's own `execute` refuses;
  Core dispatches the call (`executeHostAction` → `HostChildRuns.delegate`,
  `packages/agent-host/src/core-child-runs.ts:522`).
- **One transaction.** The parent's `effect.started`, the child's `thread.started`
  with its `origin`, the child's selection and its first `run.started` commit together
  (`prepare`, `core-child-runs.ts:733`).
- **Admission by reference.** The child's admission is derived in memory from the
  parent's: the same `LanguageModel` instance and provider `prepare`, the parent's tool
  executors narrowed by persona, the parent's memory owner and workspace binding
  (`deriveHostChildAdmission`, `child-runs.ts:195`).
- **Foreground and background.** A root delegation runs in the background unless the
  model opts out, and a child's own delegations run in the foreground
  (`hostDelegationRunsInBackground`). A foreground `join` (`core-child-runs.ts:842`)
  waits on a promise that the local fold resolves at the child's `run.finished`; the
  parent's abort stops the child. A background call returns the `started`
  acknowledgement, and the result reaches the parent later as a `run.started`
  `delivery` (a wake or the next turn) behind a durable watermark.
- **Limits.** `maxInvocations` per turn and `maxDepth` are counted from committed
  origins. One in-memory work queue per root turn holds a permit for each model
  stream and tool execution; delegation and approval waits hold none.
  `maxChildRuntimeMs` is armed per execution leg (`armDeadline`), so it never runs
  while a child waits on a person. Since ADR-0009's 2026-10-22 amendment the parent's
  watchdog never judges a running delegation: a child is bounded only by its own run.
- **Approvals.** A child's approval is an `interaction.requested` row in the child's
  own log. The parent's sidebar learns `needs-input` from `thread/children/changed`,
  and any client answers with `interaction/respond` naming the child's thread and run.
  The root's live policy governs the tree (`policyThreadId`,
  `intersectChildPermissionCeilings`). Grants live in memory per root tree
  (`grantsByRoot`), and `releaseGranted` answers every ask in the tree that a new
  grant now allows.
- **Restart.** Child runs and their interactions are marked interrupted (ADR-0010).
- **What the parent's model reads.** Only `HostChildResult.text`, through
  `toModelOutput`.

This already matches the field. The survey behind the ADR-0009 amendment (Codex,
Claude Code, Gemini CLI, OpenCode, Cline, the AI SDK, Mastra) found that:

- no parent puts a clock on a child;
- no approval wait is timed;
- child limits are child-owned;
- Codex and Claude Code deliver a background child's completion to the parent as a
  notice.

### What keeps a child on its parent's host

| Today's mechanism | Why it cannot cross a host |
| --- | --- |
| Origin, effect and first run in one transaction | Each host writes its own log (ADR-0011); no transaction spans two |
| Admission by reference | Model instances, executors and credentials are process-local by contract (`hostRunSnapshotSchema`) |
| Settlement by local fold | The parent waits on a promise its own fold resolves |
| Stop by `AbortSignal` | A signal does not cross a process |
| The turn's work queue | An in-memory semaphore |
| Grants per root tree | In memory; `releaseGranted` walks the local `runs` map |
| The workspace | The child edits through the parent's binding and filesystem |
| A client's view of a child | `thread/children` and `log/subscribe` read the parent host's log |
| Third-party agents | They speak none of the host protocol |

### The standards, by boundary (checked 2026-10-22)

**A2A v1.0.1** (2026-05-28; v1.0.0 shipped 2026-03-12). A Linux Foundation project
whose proto package is `lf.a2a.v1`. It covers agent↔agent.

- **Task states:**
  - active: `TASK_STATE_SUBMITTED`, `TASK_STATE_WORKING`;
  - interrupted: `TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_AUTH_REQUIRED`;
  - terminal: `TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`, `TASK_STATE_CANCELED`,
    `TASK_STATE_REJECTED`.

  A terminal task never restarts. Further work is a new task in the same `contextId`.
- **Resuming and auth.** An input-required task resumes with a new message on the same
  `taskId` and `contextId`. The server mints task IDs. Auth-required is a coordination
  signal, not an authorization grant (§7.6.4, added in PR #2081).
- **Methods.** JSON-RPC, gRPC and HTTP+JSON use the same names: `SendMessage`,
  `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, the
  `*TaskPushNotificationConfig` family and `GetExtendedAgentCard`.
- **Streams.** A stream closes at a terminal state, and a resubscribe starts with the
  current `Task`. A client that reconnects may miss status updates, so a stream is not
  reliable delivery.
- **Cancel** is best-effort.
- **Push** posts to a webhook `url` with a `token`, and the client must validate each
  post.
- **Agent Card.** Served at `/.well-known/agent-card.json`, it lists `skills`,
  `capabilities` (`streaming`, `pushNotifications`, `extensions`), `securitySchemes`,
  and optional JWS `signatures`.
- **Extensions** are declared by URI in `capabilities.extensions`, activated per request
  with the `A2A-Extensions` header, and carry their data in `metadata` keyed by that URI.
- **Gaps.** There is no tool-approval type and no parent/child task field.
- **SDK.** The official TypeScript SDK is `@a2a-js/sdk` 1.3.0 (2026-09-29), which
  implements v1.0.0.
- **Relation to MCP.** The spec calls the two complementary: A2A between opaque agents,
  MCP between an agent and its tools (Appendix B).

**MCP 2026-07-28** (the current revision). It covers agent↔tool.

- **Tasks became an extension.** They left the core for the `io.modelcontextprotocol/tasks`
  extension (SEP-2663), which has:
  - `tasks/get`;
  - `tasks/update {taskId, inputResponses}`;
  - a cooperative `tasks/cancel`;
  - `notifications/tasks`;
  - the statuses `working`, `input_required`, `completed`, `failed`, `cancelled`.
- **Brainstrike's pins.** `@brainstrike/mcp-tasks-extension` already pins that revision
  (ext-tasks commit `0d0a6bd`). The official SDK beside it (2.3.1) still carries the
  2025-11-25 core Tasks shape.
- **Agents.** MCP's Agents interest group is evaluating agent-as-tool and
  supervisor/sub-agent patterns. It has no extension yet.

**AI SDK 7** (`ai` 7.0.142, pinned).

- **In-process subagents.**
  - `execute` calls the subagent with the call's `abortSignal`.
  - An async-generator `execute` yields preliminary results. The SDK keeps them out of
    step content, so only the last value reaches the model.
  - `toModelOutput` shapes what the model reads.
- **Approvals.** The subagents guide's caveat reads: "Subagent tools cannot use approval
  flows such as `toolApproval`". Nested approvals are open issues (vercel/ai #18143 and
  #8380).
- **Execution callbacks.** `onToolExecutionStart` and `onToolExecutionEnd` bracket each
  execution. The ADR-0009 amendment uses them.

**AG-UI 1.0** (`@ag-ui/core` 1.0.0 on 2026-09-17, 1.0.3 on 2026-10-16). It covers
agent↔UI, one run per request over SSE.

- **Subagents.** It has `SUBAGENT_STARTED`, `SUBAGENT_FINISHED` and `SUBAGENT_ERROR`
  with a `parentToolCallId`. Most events carry a `subagentRunId`.
- **Interrupts.** A run can finish with an `interrupt` outcome. A tool approval is an
  `Interrupt` with `reason: "tool_call"` and a `toolCallId`, and the next run resumes
  with `resume[]`. Its docs still label that outcome a draft.

**ACP, the Agent Client Protocol** (schema v1.26.0, 2026-10-16). It is an editor↔agent
session over stdio.

- **Sessions.** `session/new`, `session/load` and `session/prompt`, with streamed
  `session/update`.
- **Permissions.** The agent asks the client with `session/request_permission`, whose
  options are `allow_once`, `allow_always`, `reject_once` and `reject_always`.
- **Gaps.** Subagents exist only in the unstable schema, and a remote transport is a
  draft.
- **Adoption.** Zed, JetBrains and Neovim ship clients. Claude Code and Codex connect
  through adapters.

**Claude Code and Codex** run subagents in the parent's process. A child's permission
prompt reaches the user's main surface, named by the child that asks. Claude Code
delivers a background child's result as an automated notice in a later turn.

A2A tasks, MCP's Tasks extension and Brainstrike's child runs share one shape. Each one:

- works;
- pauses for input that is answered on the same task;
- cancels cooperatively;
- ends in one terminal result.

That shared shape lets one child contract cover every place a child runs.

## Considered options

1. **Keep children in-process. Cross-host work is a separate root that a person
   starts on that host.**
   - For: nothing to build, and the in-process path is now sound.
   - Against: there is no cloud or CLI child and no third-party agent. The goal is
     one host abstraction across cloud, CLI and desktop, with agents that talk to
     agents. This option does not meet it.

2. **Stream the delegation call in the AI SDK's subagent shape, and stop there.**
   `execute` becomes an async generator that yields child status as preliminary
   results, with `toModelOutput` and abort passed through.
   - For: it is the vendor's documented pattern, and a client that watches only the
     parent's run sees the child's progress.
   - Against: it is in-process only. The AI SDK excludes approvals from subagent tools,
     so it does not answer the approval question. For a local child it duplicates what
     the client already reads from the child's own log.
   - Kept as the shape of a remote delegation call (Decision, rule 5). It does not
     answer the cross-host question.

3. **Host to host over Brainstrike's own protocol.** The parent host becomes a client
   of the child's host: `thread/start`, `run/start`, `log/subscribe`,
   `interaction/respond`, `run/stop`.
   - For: full fidelity, every method already exists, and one writer per log holds.
   - Against: it reaches only Brainstrike hosts. Its authentication is a local 32-byte
     token in `host.json`, built for stdio, a local socket and MessagePort (ADR-0017),
     not for a network. It has no discovery. Third-party agents would still need a
     second protocol.
   - Kept for its purpose: a client reading a host. A client attached to several hosts
     opens a remote Brainstrike child's full transcript on that child's own host. It is
     not the parent↔child control channel.

4. **The agent as an MCP tool, using MCP Tasks.** The child's host serves an MCP
   server whose tool runs a child. The parent calls that tool through its existing MCP
   client and Tasks extension.
   - For: it reuses Brainstrike's MCP Tasks client (`mcp.task.bound`, and
     `input_required` through elicitation to `mcp.input.requested`).
   - Against: MCP positions itself as agent↔tool. A tool call is one task, with no
     conversation identity for follow-ups. An approval has to fit a form elicitation.
     There is no agent discovery. The Tasks wire changed incompatibly between 2025-11-25
     and 2026-07-28, and MCP's Agents interest group has not settled agent patterns.
   - Rejected as the delegation route. Serving the host as an MCP server, for clients
     that speak only MCP, remains a separate decision for later.

5. **A child run is an A2A task, and every host serves A2A.** Recommended.
   - For: A2A is the open agent↔agent standard. Its task lifecycle already has the
     states a child needs: input-required, auth-required, and cancel. One route reaches
     a Brainstrike cloud host, a CLI host and a third-party agent. Agent Cards provide
     discovery. Its context and task identities map onto a child thread and a child
     run. Extensions carry a structured approval.
   - Against: A2A has no tool-approval type, so approvals need an extension. Third-party
     agents get the plain input-required path. A network-facing server is a new security
     boundary. Push notifications need an endpoint the parent can be reached at, which a
     desktop host lacks. A remote child cannot edit the parent's working tree.

6. **Replace the host's client protocol with A2A, AG-UI or ACP.**
   - For: one protocol everywhere.
   - Against: none of them covers what the host protocol is for:
     - durable log replay from a sequence number;
     - durable command identities;
     - thread management, workspace binding, MCP settings and rewind.

     ADR-0024 kept vscode-jsonrpc and the host's grammars for these reasons. Each
     candidate answers a different question: A2A is agent↔agent, AG-UI is one agent's
     events to a UI, and ACP is an editor's session with an agent.
   - Rejected. An ACP or AG-UI facade for third-party clients, as an adapter over the
     same Core, is a separate decision for later.

## Decision (proposed)

### One standard per boundary

| Boundary | Standard | Change |
| --- | --- | --- |
| Host ↔ client (desktop, CLI, a future web or cloud client) | The Brainstrike host protocol, JSON-RPC 2.0 (ADR-0017, ADR-0024) | None. Remote children are listed with a locator |
| Parent ↔ child on the same host | Host-internal: one Core, one log | None to the mechanics. The runner seam reports A2A states |
| Parent ↔ child on another host, or a third-party agent | A2A | New: a remote child is an A2A task |
| The delegation call inside the AI SDK loop | The AI SDK subagent pattern | Remote children only: preliminary results, `toModelOutput`, abort |
| Agent ↔ tool | MCP, with `io.modelcontextprotocol/tasks` for long calls | None |

### Rules

1. **A child is a task, wherever it runs.** In-process, on another Brainstrike host or
   in a third-party agent, the parent sees one lifecycle, A2A's.
   - An in-process child keeps today's mechanics, because they are host-internal: the
     one transaction, the local fold, the shared work queue and the root's grants. The
     child-runner seam (step 2 below) reports its states in A2A's terms. The host's
     client wire names do not change.
   - A remote child is an A2A task that the parent host holds a reference to.
2. **The host that runs a child owns every fact about the child's run.** The child's
   transcript, tool effects, approvals and answers are written once, in that host's log.
   The parent host never mirrors them. It records only its own facts:
   - its delegation call;
   - the reference to the remote task;
   - what it delivered to its own model.
3. **A child's approval goes to a person or to the root's policy, never to the parent's
   model.** This is already true in-process. Claude Code and Codex do the same, labelling
   the prompt with the child that asks. The AI SDK keeps approvals out of subagent tools
   altogether.
4. **The parent never times a child.** A remote child's limits belong to its host: that
   host's watchdog, step budget and per-leg `maxChildRuntimeMs`. The parent cancels only
   on a person's Stop, a root Stop or its own abort.
5. **A remote delegation call follows the AI SDK subagent pattern.** Its `execute` is an
   async generator over the A2A task's events.
   - Each status update is a preliminary result. That is live telemetry, never committed
     (ADR-0011 amendment); the SDK leaves preliminary results out of the step content.
   - The terminal task gives the final result.
   - `toModelOutput` still gives the model only the child's text.
   - The call's `abortSignal` cancels the task.
6. **Each host serves A2A as one more client of its own Core.** It becomes a new client
   origin beside `desktop-ui` and `public-socket` (`HostClientOrigin`,
   `packages/agent-host/src/ports.ts:452`). Capabilities bound to an origin, such as
   provider sign-in and browser answers, refuse it as they refuse `public-socket`. It
   commits through Core's single writer. Where it is on by default is open question 2.

### Identities

| A2A | Brainstrike host |
| --- | --- |
| Agent Card | The host's personas as `skills`, its endpoint, its security schemes and the approval extension. Derived, never stored |
| `contextId` | The child thread on the child's host |
| `taskId` | One child run. A later message on the same context starts a follow-up run, which is today's typed follow-up, and its `referenceTaskIds` name the earlier run |
| `messageId` of the delegating message | Derived from the parent's committed tool call, as a `commandId` is today. A Brainstrike child's host refuses a duplicate through its command ledger. Whether a third-party agent deduplicates is unverified |
| A message on an input-required task | `interaction/respond` or `interaction/resume` |
| `CancelTask` | `run/stop` |
| Artifact | The run's final answer (`hostAnswerText`) |
| Parent and child | No A2A field exists. The delegation metadata carries them under the extension: the parent's agent, thread, run and `toolCallId`, the depth, `maxDepth` and the permission ceiling |

### States

| Child run on its host | A2A task state | `HostChildResult.status` on the parent |
| --- | --- | --- |
| Accepted, not yet admitted | `TASK_STATE_SUBMITTED` | `started` |
| Running, nothing pending | `TASK_STATE_WORKING` | `started` |
| An approval, question, plan or network consent is pending | `TASK_STATE_INPUT_REQUIRED` | `started` (the card shows needs-input) |
| A sign-in the child's host cannot finish itself | `TASK_STATE_AUTH_REQUIRED` | `started` |
| `run.finished` `completed` | `TASK_STATE_COMPLETED`, with the answer as an artifact | `completed`, or `no-answer` when the answer is empty |
| `failed`, or `interrupted` by a restart | `TASK_STATE_FAILED`, with the reason | `failed` or `interrupted` |
| `stopped` | `TASK_STATE_CANCELED` | `stopped` |
| Refused before admission (a limit, an unknown skill, the policy) | `TASK_STATE_REJECTED` | `rejected` |

The host's own wire names (`HostChildStatus`, `HostChildResult`) stay as they are. The
mapping lives only in the A2A adapter.

## Approvals inside a child, across hosts

The host that runs a tool owns that tool's approval. A person answers wherever they
are, and the answer travels to the owning host.

### An in-process child

Unchanged (ADR-0010).

### A remote Brainstrike child

1. **The child asks.** The child's host commits `interaction.requested` in its own log
   and moves the task to input-required. Its status message carries a data part under
   Brainstrike's approval extension:
   - the `interactionId` and `toolCallId`;
   - the tool, its risk and its target root;
   - a digest of the exact input it would run.

   Inputs the host redacts stay redacted.
2. **The root's policy goes first.** The parent host offers the ask to the root's live
   policy. When that policy now allows the tool or its risk category, the parent answers
   as the policy (`by: 'policy'`). That is `releaseGranted`'s rule, applied across
   hosts.
3. **Otherwise a person is asked.** The parent host yields the ask as a preliminary
   result of the delegation call and publishes `thread/children/changed`. It commits
   nothing, because the ask is the child host's fact. The delegation card shows the ask,
   named by the child that asks.
4. **The answer travels.** A person answers with `interaction/respond`, or with
   `interaction/resume` for an answer that carries data. The answer names the parent's
   delegation call and the `interactionId`. The parent host sends it to the task as a
   message on the same `taskId` and `contextId`, with the decision and any grant under
   the extension.
5. **The child's host checks and commits.** It checks the answer against the pending
   interaction: the same `interactionId` and the same input digest. It then commits
   `interaction.responded`, plus `permission.granted` when a grant came with the answer,
   and resumes. The task returns to working.
6. **A direct answer.** A client that can reach the child's host directly may answer
   there with an ordinary `interaction/respond`. The child's host commits the first
   answer and refuses a second (ADR-0010).

**Why an answer names the exact input.** A2A's input-required is a generic pause. An
answer that says only "yes" can be applied to a different action from the one the
person saw.

### Other cases

- **A third-party agent without the extension.** Its input-required message shows as a
  `question` interaction on the delegation card. The person's reply goes back as a
  message on the same task. The parent's model never answers it.
- **Auth-required.** The child's host needs a sign-in it cannot complete itself, such as
  an MCP server's OAuth. The card shows that sign-in, and the person completes it with
  that service. The parent forwards no credential of its own.
- **Ceilings.** The delegation's metadata carries the root's ceiling for this child:
  allow, ask or deny for each risk category, plus the admitted tool IDs. A Brainstrike
  child's host intersects the ceiling with its own policy and never widens it, as
  `intersectChildPermissionCeilings` does in-process.
- **Restart.**
  - A served task is a top-level run on its own host. Under ADR-0010 its pending
    approval therefore survives that host's restart, and the parent resubscribes.
  - When the parent host restarts, a foreground delegation is interrupted like any
    running action (ADR-0010), and recovery cancels the task bound to it.
  - A background delegation across a parent restart is open question 3.

## Who owns each fact

Each fact has one writer, and every other host or client reads that fact from its
writer.

| Fact | Writer | Where it lives | How others see it |
| --- | --- | --- | --- |
| The delegation call and its result | Parent host | Parent log: `effect.started`, `effect.finished` | Folded from the parent log |
| An in-process child's origin and runs | That host | Its log, in one transaction (unchanged) | `thread/children`, `log/subscribe` |
| The reference to a remote child (agent URL, context ID, task ID) | Parent host | Parent log: a new `child.task.bound`, shaped like `mcp.task.bound` | Folded from the parent log |
| The inbound caller of a served task (caller's agent and its call, as given) | Child's host | Child log: `thread.started` with a remote `origin` | That host's own `thread/children` and log |
| A remote child's runs, transcript, tool effects, approvals and answers | Child's host | Child log | A2A task events; a client attached to that host directly |
| A child's status | Nobody: always derived | — | Local: from its runs (`hostChildStatus`). Remote: from the task's last state |
| Delivery to the parent's model, and its watermark | Parent host | Parent log: `run.started` `delivery` | Folded from the parent log (unchanged) |
| The root's permission policy and its session grants | Root host's policy owner | The root host (unchanged) | Applied to local children directly; to remote children as policy answers |
| A grant that came with an answer to a remote child | Child's host | Child log: `permission.granted` | Its own fold |
| Credentials (provider keys, MCP OAuth, tokens) | Each host's platform secret store | That host only | Never crosses a host. `auth-required` asks the person to sign in on the child's host |
| The Agent Card | The serving host, derived from its personas | Nowhere: derived, never stored | Fetched from the host |
| Which personas run remotely, and where | The subagent settings owner | Existing persona settings | Admission |
| The parent's push-notification endpoint and its token | Parent host | Its secret store | Given to the child's host in the push configuration |
| A remote child's workspace changes | Child's host | Its own checkout or sandbox | Returned as artifacts, such as a branch or a patch |

## What changes first

Each step is useful on its own and testable in isolation.

0. **Prerequisite: land the watchdog fix** (`claude/thread-crash-debug-fd9a22`). With it,
   a parent no longer times its child, which rule 4 assumes.
1. **Owner decisions** on the open questions below. No code until then.
2. **Name the seam, in-process only.** Split `HostChildRuns` into two parts:
   - the parent-side ledger, which keeps origins, invocation counts, delivery, the
     watermark and wakes;
   - a child runner with four operations: start, events, answer and cancel.

   The local runner is today's code. There is no wire change, and the existing
   delegation suites pass unchanged.
3. **Serve A2A from the CLI host (inbound).**
   - The Agent Card is built from the host's personas.
   - An incoming message starts a run.
   - A pending interaction puts the task in input-required.
   - An answer becomes `interaction/respond`.
   - Cancel becomes `run/stop`.

   Prove it against a CLI host on loopback, with the official A2A SDK client and the
   A2A TCK (`github.com/a2aproject/a2a-tck`). This step is useful by itself: other
   agents can delegate to Brainstrike.
4. **The remote runner (outbound).**
   - A persona names an Agent Card URL.
   - The parent commits `effect.started`, then `child.task.bound` once the task exists.
   - A foreground call streams, yielding preliminary results, and cancels on abort.
   - A background call reports through the existing delivery. It holds the stream,
     resubscribes after a reconnect, and uses push only where the parent has an endpoint
     the child's host can reach.

   Prove it with one Brainstrike CLI host delegating to another on loopback.
5. **Approvals across hosts:**
   - the approval extension;
   - answers forwarded by the parent;
   - policy answers;
   - the question path for agents without the extension;
   - auth-required.
6. **Clients.** `thread/children` lists remote children with a locator and state. A
   client that can reach a remote Brainstrike host attaches to it to read the child's
   transcript.
7. **The cloud host.** The same bundle runs with a cloud `HostPlatform` (secrets,
   sandboxed workspace, an A2A endpoint). That needs its own ADR.

## Consequences

- **Protocol bump.** The host protocol version bumps for three additions:
  - `child.task.bound` in the parent's log;
  - a remote `origin` variant on `thread.started` in the child's log;
  - an `interaction/respond` and `interaction/resume` target that names a parent's
    delegation call instead of a local child run.
- **A new client origin and a network listener.** Both need a security review. The
  desktop leaves the listener off by default.
- **Workspace.** A remote child cannot edit the parent's working tree. Its changes come
  back as artifacts, so a persona that edits in place stays local.
- **Limits.** The turn's work queue does not cover remote children; `maxInvocations`
  does. Depth travels in the delegation's metadata. A third-party agent may ignore it,
  and its own limits govern it.
- **Model.** A remote child runs the remote host's model, unlike an in-process child,
  which inherits its parent's model
  ([subagent contract](../agents/assistant-subagents.md)).
- **Usage and cost.** These stay on the ledger of the host that ran the work. The parent
  sees only what the task reports.
- **Unchanged:**
  - in-process delegation, its tests and its restart rules (ADR-0010);
  - the client protocol's transport and grammar (ADR-0024);
  - the AI SDK loop and Mastra as a memory library (ADR-0012);
  - MCP.

## Open questions for the owner

1. **The standard.** Is A2A the parent↔remote-child standard, rather than an agent served
   as an MCP tool? Recommended: A2A.
2. **The listener.** Should the host get a network-facing A2A server? The proposal is on
   for CLI and cloud and off by default on desktop. Which authentication should it use:
   a bearer token, OAuth 2.1 client credentials, or mTLS?
3. **A background remote child across a parent restart.** Should the parent re-attach
   and deliver the result, since the task outlived it? Or cancel the task, as an
   in-process child is interrupted?
4. **Workspace.** Which personas may run remotely, and does a remote worker return a
   branch, return a patch, or open a PR?
5. **Grants.** Should a root session grant also answer a remote child's later asks
   (policy answers, recommended)? Or only the ask it came with?
6. **Model and cost.** A remote child runs the remote host's model and bills that host's
   ledger. Should the parent's ledger show the usage the task reports?
7. **Client facades.** Should ACP (editors) and AG-UI (web) be adapters over Core? Each
   would be its own decision, after this one.

## Sources

Standards (checked 2026-10-22):

- **A2A:**
  - specification v1.0: <https://a2a-protocol.org/latest/specification/>;
  - releases: <https://github.com/a2aproject/A2A/releases>;
  - proto at v1.0.1: <https://github.com/a2aproject/A2A/blob/v1.0.1/specification/a2a.proto>;
  - what's new in v1: <https://a2a-protocol.org/latest/whats-new-v1/>;
  - task life cycle: <https://a2a-protocol.org/latest/topics/life-of-a-task/>;
  - extensions: <https://a2a-protocol.org/latest/topics/extensions/>;
  - §7.6.4: <https://github.com/a2aproject/A2A/pull/2081>;
  - `@a2a-js/sdk` 1.3.0: <https://github.com/a2aproject/a2a-js>.
- **MCP:**
  - 2026-07-28 changelog: <https://modelcontextprotocol.io/specification/2026-07-28/changelog>;
  - SEP-2663: <https://modelcontextprotocol.io/seps/2663-tasks-extension.md>;
  - the extension: <https://github.com/modelcontextprotocol/ext-tasks>;
  - 2025-11-25 Tasks: <https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks>;
  - Agents interest group: <https://modelcontextprotocol.io/community/interest-groups/agents.md>.
- **AI SDK 7.0.142:**
  - subagents: <https://ai-sdk.dev/docs/agents/subagents> (installed copy
    `node_modules/ai/docs/03-agents/06-subagents.mdx`);
  - tool approvals: <https://ai-sdk.dev/docs/agents/tool-approvals>;
  - preliminary results: <https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling>;
  - open issues: <https://github.com/vercel/ai/issues/18143>,
    <https://github.com/vercel/ai/issues/8380>.
- **AG-UI 1.0.3:**
  - events: <https://docs.ag-ui.com/concepts/events>;
  - interrupts: <https://docs.ag-ui.com/concepts/interrupts>;
  - subagents: <https://docs.ag-ui.com/concepts/subagents>.
- **ACP schema v1.26.0:**
  - tool calls: <https://agentclientprotocol.com/protocol/tool-calls>;
  - transports: <https://agentclientprotocol.com/protocol/transports>.
- **Peers:**
  - Claude Code: <https://code.claude.com/docs/en/sub-agents>;
  - Codex: <https://developers.openai.com/codex/subagents>.

Code at `fc87801f4`:

- `packages/agent-host/src/core-child-runs.ts`;
- `packages/agent-host/src/child-runs.ts`;
- `packages/agent-host/src/protocol.ts` (`HostChildOriginSchema`,
  `HostChildDeliverySchema`, `mcp.task.bound`);
- `packages/agent-host/src/ports.ts` (`HostRunAdmission`, `HostClientOrigin`);
- `packages/mcp-tasks-extension/src/provenance.ts`;
- [the subagent contract](../agents/assistant-subagents.md).

The watchdog fix, on branch `claude/thread-crash-debug-fd9a22` (`d083d27bb`), carries the
ADR-0009 amendment that this ADR assumes.
