# Subagents working end to end: Mastra upgrade and PR #3337 repair

**Status: APPROVED FOR IMPLEMENTATION, 2026-09-26.** This specifies the complete
delivery, not an assertion that the implementation works. The user authorized
minimal, demonstrated Mastra fixes alongside application corrections. This does
not permit private API usage in Brainstrike, monkeypatches, suppressed failures,
disabled supported features, weakened tests, or bypassed hooks.

## 1. Outcome and scope

A user can delegate work to concurrent children, inspect their conversations,
approve or decline their tools, interact with supported child controls, and stop
the selected child without disrupting siblings. This continues to work through
parent runtime reconstruction, renderer reload, and application restart. Reads,
approved file edits and commands perform the intended work, with accurate
permissions, output, usage and durable state.

The delivery includes upgrading Mastra, repairing the application integration,
reducing the vendor patch to demonstrated defects, integrating the existing
PR #3337 review fixes, proving desktop behavior, and completing normal review
and merge gates. Dependency upgrade alone is not completion.

Preserve these checkouts and all their existing changes:

- PR: `/Users/seandearnaley/.codex/worktrees/69d3/brainstrike`.
- Unpatched upgrade: `/Users/seandearnaley/.codex/worktrees/fix-active-embedding-stop/brainstrike`.

The current candidate is in `/Users/seandearnaley/.codex/worktrees/7b2f/brainstrike`,
branch `codex/prove-unpatched-delegation`. Its experiments are uncommitted and
are not the approved final implementation. The experimental `OwnedChildRun` and
`ChildExecutionOwner` classes were removed after native cancellation and cleanup
proved the required behavior without them.

## 2. Fixed constraints and revisable decisions

Preserve product invariants: exact permission and decision identity; read-only
persona boundaries; user-configured recursion and work budgets; independent child
conversations; durable, correctly attributed output; truthful cancellation and
failure; no duplicate execution from repeated approval or recovery; existing
workspace, credential, memory and factory-reset boundaries.

Keep native `Agent({ agents })` delegation. Parent and children use Mastra's
agent loop. Brainstrike retains its existing permission, admission, persistence,
stream-mapping and UI responsibilities. Do not introduce a second agent loop,
custom delegation tool, second scheduler, AgentController migration or replacement
agent framework within this work.

Implementation decisions may change when a focused reproduction and replacement
test justify them. In particular, the current prohibition on production
`untilIdle`, the custom `withBackgroundIdleLoop`, `_skipBgTaskWait`, old identity
scans and vendor patches are not product requirements. Preserve the behavior
they were intended to protect, then remove obsolete machinery. Update affected
living contracts and paired guards with the implementation; record the rationale
in evidence files. A draft spec does not itself change those contracts.

### 2.1 Idiomatic integration is an acceptance requirement

Optimize for the smallest understandable integration with clear ownership and
easy dependency upgrades. Merely calling exported methods is insufficient: a
supported hook can still be used to construct an unnecessary second runtime.

Use this order of preference:

1. The installed stable version's documented native composition, corroborated
   against current official reference examples and public types.
2. A thin application adapter for Brainstrike-specific authorization, storage or
   UI requirements through documented extension points.
3. A narrow framework repair that restores documented behavior and can be
   expressed and tested without Brainstrike-specific concepts.

Do not build a compensating application subsystem to avoid a small justified
framework repair. Conversely, do not patch the framework to impose product policy
that belongs in Brainstrike. A missing supported capability is a design gap to
review explicitly, not automatically an upstream bug.

Mastra should own agent iteration, native task execution, suspension and native
workflow cleanup. Brainstrike should own user authority, durable decision
admission and product projections. The execution owner in section 4.1 describes
an accountability boundary, not a requirement for a new class, registry or
parallel state machine. Prefer existing owners and native completion handles;
introduce additional bookkeeping only when a required product responsibility
cannot be represented there, with one identified lifetime and cleanup boundary.

### 2.2 Prove the reference composition before production migration

The first implementation gate is a small executable reference using native
`agents`, supervisor-level `backgroundTasks.tools`, documented streaming and
approval/resume APIs, and storage through public adapters. Exercise the entire
concurrent read/approval/reconstruction/write/Stop slice together. Individually
passing hooks do not establish that their composition is supported or correct.

For each deviation from that reference, record the requirement, documented
extension point, reproduction, and why the simpler composition is insufficient.
Separate application misuse, documented behavior, implementation defect and
missing capability. When documentation and observed behavior disagree, retain
the reproduction and state the discrepancy; do not choose whichever permits the
desired implementation.

Before integrating the reference, require a compact architecture review covering:

- Who starts, resumes, cancels and joins each operation, including errors.
- Which state is authoritative and which UI records are derived projections.
- Which existing wrappers, patch hunks and experimental owners will be deleted.
- Why each remaining adapter or patch exists and how a future version replaces it.

Reject a candidate that passes behavior tests by adding a second scheduler,
duplicated lifecycle state, output filtering without proven provenance, private
escape hatches or overlapping cleanup owners. Passing end-to-end tests is
necessary; maintainable ownership and idiomatic library use are also required.

These gates resolve the current unknowns before a broad production migration.
They do not promise that a documented API has already met every product invariant.

## 3. Evidence at the starting point

These findings come from the handoff, current source and local experiments.
They must not be represented as full desktop acceptance.

| Finding | Classification | Required disposition |
| --- | --- | --- |
| A reconstructed root approval can resume children without registered executors | Application defect | Restore authorized executors before any native resume |
| The resume adapter drops public `suspendedToolRunId` | Application defect; focused fix passes | Forward the supplied identity; remove superseded vendor patch |
| Current-call identity is searched for in pre-model prompt messages | Application API misuse; focused fix passes | Capture observed hook input and native call identity |
| Resumed tasks can be absent from output classification | Application defect | Establish ownership before resumed output is emitted |
| Native wrapper failures can leave running children/actionable approvals | Application defect | Join failure settlement and update exact durable owners |
| Stock background child output can reach task and parent channels | Reproduced native behavior; limited public-processor proof | Prove one complete delivery path for every supported mode |
| Selected public abort can stop one same-persona child without stopping its sibling | Focused capability proof | Integrate with admission, durable status and cleanup |
| Workflow deletion can outlive shutdown; rejected deletion can escape as an unhandled rejection | Reproduced failure; source identifies unawaited deletion | Repair native promise ownership and prove error propagation |
| SemanticRecall repeatedly constructs WASM hashers | Allocation observation, not proof of retained-memory exhaustion | Measure real lifecycle memory behavior before retaining a patch |

Current checked stable baseline is `@mastra/core` 1.71.0 and `@mastra/memory`
1.32.1. Recheck published stable versions before implementation and before
delivery. Pin the selected versions and patch target reproducibly. A later
stable release requires an explicit upgrade-impact check and relevant tests;
do not silently change the candidate or label an older version latest.

## 4. Technical design

### 4.1 One execution owner for each admitted native attempt

Use the existing host ownership/admission services as the authority. Identify an
invocation with its durable owner, root/original turn, parent invocation, child
thread/resource, native run/tool-call and background task identities. A resumed
execution leg belongs to that invocation; it is not a newly invented child.

Capture identity at public native hooks and validate it against persisted host
bindings. Model input, persona names, parsed ID strings and prompt-history scans
are not authority. Repeated invocations of one persona must remain independent.

Register execution, output routing and cancellation before work can emit output.
Keep ownership through native stream consumption, tool `finally` blocks, memory
settlement, workflow cleanup and durable terminal projection. Release it only
after those operations settle. An owner supervises native execution; it does not
run an LLM loop or make scheduling decisions in parallel with Mastra.

The host owns admission and authorization. Mastra owns its native execution and
workflow snapshots. The stream adapter maps authorized output into Brainstrike's
existing `StreamChunk` contract. The application owns the shared database; child
runtime disposal must never close a database borrowed from it.

### 4.2 Approval, suspension and reconstruction

Use the public approval/decline and suspension-resume APIs appropriate to the
native pause. Preserve approval versus question versus plan semantics. A pending
notice identifies the originating child, actual tool/action and target, plus the
immutable leaf decision identity behind any root transport envelope.

On a decision, reauthorize the full invocation path and claim the exact leaf
using existing durable admission. Revalidate the native snapshot after admission.
Reconstruct agents, shared memory, permissions and public task executors before
resume. Forward native resume data and `suspendedToolRunId`. Register output and
cleanup ownership before invoking the executor. Remove internal `taskContexts`
inspection and other private framework access from this path.

Read grants, per-call approval, session grants and deny policies retain their
existing scope. A session grant cannot widen persona authority, revive stopped
work or replay interrupted decisions. Simultaneous parent and child decisions
must serialize according to the existing durable root claim without losing or
misrouting either pending decision.

Repeated clicks, duplicate requests and stale tabs must not execute a tool twice.
Pre-execution admission failures may release only their own provably unexecuted
claim. Once execution may have started, preserve the receipt and report the
actual outcome or interruption; do not make it actionable again by guessing.

### 4.3 Exactly-once acceptance and crash limits

For parked approvals that are safely resumed, require one actual tool invocation
and one intended file/command effect, including after runtime reconstruction or
restart. Repeating the decision must add zero invocations/effects. Instrument a
counter or append-only test receipt: final file contents alone cannot detect two
identical writes.

A crash after an arbitrary external command or write starts can leave its outcome
uncertain. Existing decision receipts prevent automatic replay; they do not make
external side effects transactional. Preserve the existing terminal interrupted
state, lock the decision, and show uncertainty without claiming success. No
automatic retry or rollback is promised for arbitrary commands. Test crashes
before admission, after claim, and after a side effect but before completion is
recorded. This is a required correctness case, not a deferred recovery feature.

### 4.4 One authoritative output path

For each native child call, select exactly one delivery into the Brainstrike
mapper. Preserve text, reasoning where supported, tool lifecycle/results,
custom data, approvals, typed pauses, errors and usage. Keep full child output in
the child conversation and the existing bounded result in the parent context.

Use native identity and trusted host correlation for attribution. Do not
deduplicate by payload equality: two identical legitimate outputs remain two.
Do not drop entire chunk families or disable streaming to conceal duplication.
Initial, resumed, foreground, background and recursive paths must share the
same attribution rules. Parent summaries and ledger entries remain distinct from
raw child transcript content.

First test public processors end to end. If they require a fragile parallel
routing mechanism, compare that with a narrow source-level repair of native
duplicate emission. Select one strategy and remove the competing experiment.
Passing only the background custom-data probe does not decide this choice.

### 4.5 Parent continuation

Decision approved by the user after the reference gate: retain one Brainstrike
parent-turn coordinator using public Mastra `stream` and task-manager APIs.
Native `untilIdle` cannot reserve an in-flight durable host decision. A child's approval pause must reach the user
without invoking the parent model merely to relay the pause. Siblings continue,
and terminal results reach the correct parent generation exactly once. Pending
root approval must coexist with child progress and parked child approvals.

Reproduce suspension, mixed running/paused siblings and resumed-result behavior
on the chosen stable version before replacing the current wrapper. If native
continuation violates required behavior, a bounded upstream repair is eligible
under section 5. Do not retain `_skipBgTaskWait` or silently remove the product
invariant. If the necessary repair becomes a scheduling redesign, stop that
branch of work and present the concrete architectural decision for review.

### 4.6 Stop, failure and shutdown

Stop resolves the authorized selected conversation or explicitly selected
subtree, including its admitted invocation legs. First durably revoke further
admission. Then abort the corresponding native execution through public scoped
controls and join actual operations and cleanup. Same-persona siblings must not
share cancellation merely because they share an Agent instance.

Successful Stop acknowledgement means owned execution and cleanup have settled;
no new tool/model operation or late write from that stopped attempt may occur
after acknowledgement. A side effect completed before cancellation is not
rolled back. Commands must terminate and join their owned process execution;
changing a task status or ending its output stream is insufficient.

A failed or unjoinable cleanup produces explicit incomplete cancellation with
admission still revoked. Never report successful Stop on a timeout. Preserve
original and cleanup failures together. Root Stop follows the existing turn/tree
scope; unrelated roots and siblings outside the selected scope remain usable.
Closing a child tab is not Stop.

For native background start/restart/resume, retain the full execution and workflow
deletion promise. Cancellation joins the selected task; shutdown joins all owned
work, including already-terminal tasks whose deletion is outstanding. Stop new
admission before draining so no later operation can evade the join. Suspended
snapshots needed for normal recovery must survive ordinary runtime disposal;
explicit cancellation follows the existing snapshot cleanup contract.

## 5. Minimal Mastra patch policy

Patch the selected stable package through the repository's normal reproducible
package patch mechanism. Never edit installed packages ad hoc or add runtime
interception. Brainstrike code continues to use exported public APIs; repairing
internal implementation inside an explicit vendor patch does not license private
API calls from the application.

Each logical patch needs: a public-API minimal reproduction; an explanation of
expected and observed behavior; RED on pristine dependencies; GREEN with the
patch; adjacent normal/error/cancellation tests; and a removal condition tied to
a fixed upstream release. Account for relevant published module formats. No
patch may turn a failure into logged success.

| Candidate | Initial disposition |
| --- | --- |
| Background execution/deletion ownership and join/error propagation | First repair candidate; failure is demonstrated |
| Duplicate background output | Decide from complete routing proof; do not automatically restore old hunk |
| Default child abort-signal composition | Prefer proven public scoped abort; patch only if required behavior still fails |
| Suspended child run identity | Remove old hunk; fix the application adapter |
| Shared semantic-recall hasher | Decide from real memory/recall lifecycle measurements |
| Native continuation on suspension | New candidate only if the documented public path reproduces the violation |

Minimal means the smallest coherent correctness repair, not a predetermined hunk
count. Do not reapply the old 474-line bundle wholesale. Keep no duplicate
application workaround for behavior the final patch correctly owns.

Prepare upstream-ready reproductions and issue/PR drafts for retained framework
defects, checking existing upstream reports first. Submission is a separate
explicitly authorized external action. Upstream acceptance is not required to
ship a locally proven patch; an upstream report is not proof that our patch works.
Do not blame Mastra for application integration errors. Other dependency patches
are unchanged unless a demonstrated blocker in this acceptance scope requires a
separately justified repair.

## 6. End-to-end acceptance matrix

Use real Electron, the real assistant host/transport, real PGlite and temporary
workspace files/commands. Deterministic tests may script the provider endpoint,
not the assistant stream or host behavior. Assert UI state, native/host identity,
durable records and actual effects together. Perform a manual desktop pass with
a real configured provider after deterministic acceptance.

| Case | Required observable result |
| --- | --- |
| Concurrent read-only children | Reads overlap, correct results reach each child and parent; mutation and recursive delegation remain unavailable |
| Concurrent workers, including the same persona twice | Distinct identities and transcripts; each completes its assigned work |
| Read permission ask/allow/deny | Correct policy and labels; deny performs no read; grants remain scoped |
| Write approval | No write before approval; one invocation/effect afterward; exact child/file shown |
| Command approval | Exact command/workspace and child shown; no execution before approval; one execution afterward |
| Decline | No effect; settled declined control persists across reload; parent/other children continue |
| Session grant | Only eligible pending work resumes; interrupted/stopped leaves remain locked; no authority expansion |
| Repeated or racing decisions | Parent view, child view and stale view cannot execute the same leaf twice |
| Mixed parent and child approvals | Correct controls stay visible; root decision does not lose parked children or trigger an existing-host error |
| Multiple successive child pauses | Every leaf decision stays distinct despite reused root transport identity |
| Question and plan tools | Supported personas receive correctly typed controls and exact resume; child plan does not change root plan mode |
| Foreground and background output | Every supported output type delivered once to its owner; identical legitimate parts preserved |
| Recursion | Worker grandchild retains identity, memory, permission, budget and output scope; leaf personas cannot delegate |
| Child conversation interaction | Open/close/reopen works; active follow-up targets the child; supported idle follow-up has its own receipt and correct persona |
| Renderer reload/reconnect | Existing work and approvals reattach without a new execution; settled decisions remain locked |
| Parent runtime/storage reconstruction | Both parked children can resume; executors restored first; reads and completed writes are not replayed |
| Actual application restart | On-disk pending decisions rediscovered and safely resumed; interrupted decisions remain visibly terminal |
| Crash at decision/effect boundaries | No automatic replay of possibly executed work and no fabricated success |
| Selected Stop during inference/read/write/command | Selected execution observes cancellation; acknowledgement joins cleanup; no post-acknowledgement work |
| Selected Stop while queued, paused or resuming | Admission/decision race cannot restart selected work; pending UI becomes non-actionable |
| Subtree Stop and root Stop | Correct existing scope stops; descendants cannot spawn new work; unrelated work survives |
| Stop against same-persona siblings | One child stops while another completes and writes once |
| Delayed cleanup and cleanup rejection | Stop/shutdown wait for held cleanup; rejection reaches owner with no orphan rejection or false success |
| Tool/provider/storage failure | Correct child failure and parent result; no stuck running row, stale actionable approval or lost original error |
| Budgets, watchdog and deadline | Existing limits apply across recursion/resume; no automatic tool retries or silent deadline extension |
| Usage and parent reconciliation | Each leg charged once under existing accounting; compact parent results and full child transcripts survive reload |
| Memory lifecycle | Semantic recall and enabled memory features work over repeated/concurrent children without reproducible unbounded retained growth or WASM failure |
| Upgrade compatibility | Existing persisted conversations/approvals remain supported or receive their existing explicit incompatibility outcome; no snapshot rewriting or silent loss |

For the memory experiment, record warm-up, repeated sequential/concurrent batches,
process memory and relevant WASM measurements, runtime settings and teardown.
Define the measurement protocol before comparing stock/patched results. Allocation
count alone is not a leak verdict; arbitrary sleeps or a conveniently increased
memory limit are not repairs. A justified lifecycle fix must preserve recall.

## 7. Delivery sequence and gates

1. **Freeze acceptance and inventory.** Recheck PR #3337 head, all review findings,
   checks, both preserved diffs, current branch/base and installed/published
   versions. Capture the bounded reproductions and fixture identities before
   changing behavior. Classify findings as application defect, vendor defect or
   unproved hypothesis.
2. **Repair the native lifecycle slice.** Pass the reference-composition and
   architecture gates in section 2 first. Correct public API usage; prove cleanup
   ownership, output routing, native continuation and isolated Stop on the chosen
   version. Use only necessary tested vendor hunks. Gate: concurrent read →
   approval → reconstruction → single write → correctly attributed output, plus
   selected Stop with a live sibling, all GREEN including injected errors.
3. **Integrate one production path.** Wire the proven ownership into existing
   host services; integrate PR review fixes; remove private access, obsolete
   patches and competing experiments. Gate: production host integration and
   real process-restart tests pass. A green isolated probe cannot override a red
   assembled test.
4. **Prove desktop acceptance.** Complete section 6, including manual labels and
   real-provider interaction. Diagnose failures in the actual path. Do not swap
   in mock assistant streams, loosen assertions, or disable features.
5. **Deliver.** Run normal build, types, lint/Ultracite, relevant unit/integration,
   contract and E2E checks and commit/push hooks. Collect and remediate reviews in
   one coherent batch per head. Merge only with current-head required checks and
   completed review coverage; verify the merged main revision afterward.

Use one coherent candidate for the lifecycle repair and upgrade; reconcile it
with #3337 after inventory. Do not blindly cherry-pick or overwrite either
preserved worktree. No speculative multi-PR program. Split only if a prerequisite
is genuinely independent, reviewable and green, with the resulting delivery order
made explicit. Unrelated cleanup is outside this scope.

Current repository CI gates are Static, Unit, Build, Web E2E and Desktop E2E;
re-read live rules and review requirements at delivery. Follow current repository
review budgets/checkpoints from the new implementation start. Inherit no old
agent assignments, model roles, automations or timers, and create no recurring
monitor for this work. No `--no-verify`, empty pushes or review-trigger tricks.

## 8. Completion, blockers and final explanation

The work is complete only when the architecture gates and full acceptance matrix
pass on the delivered revision, no known in-scope defect remains, every surviving Mastra patch has its
own demonstrated reason, the required reviews/checks pass and the fix is merged
and verified. Report exact versions, patch dispositions, tested revision and any
limits of the evidence. Keep test/run links in the delivery report; introduce no
new CI proof-artifact framework.

If a required invariant cannot be met without a forbidden technique or an
unbounded framework redesign, stop that implementation path. Present the exact
reproducer, impact and concrete alternatives. Do not merge a partial solution or
rename a blocker as a follow-up. Smaller unresolved hypotheses must be tested,
not treated as proof that subagents cannot work.

The final explanation must show how the completed design addresses the observed
fragility: durable tasks outliving request-scoped executor closures; current-call
identity inferred from the wrong data; two child-output channels; and task status
or stream closure mistaken for settled execution/storage work. Explain the
resulting ownership and why each removed workaround is unnecessary. Do not claim
the architecture is repaired merely because those causes have been described.

## 9. Review decision

This draft proposes native Mastra delegation on the latest verified stable release,
with minimal reproducible vendor repairs, complete application integration and
desktop acceptance before merge. It explicitly excludes a separate child loop.

The decisions requiring experimental resolution are the final output route,
native continuation behavior, cancellation/cleanup joins and semantic-recall
memory behavior. They are bounded gates inside this work, not promises that a
particular patch count or implementation already works.

## References

- [Current subagent contract](../../agents/assistant-subagents.md)
- [Runtime and permission contract](../../agents/assistant-runtime.md)
- [Persistence contract](../../agents/assistant-persistence.md)
- [Mastra boundary](../../agents/mastra-boundary.md)
- [Review and CI requirements](../../agents/ci-quality.md)
- [Official native subagent documentation](https://mastra.ai/docs/subagents)
- [Official background-task documentation](https://mastra.ai/docs/harness/background-tasks)
- [Official approval and suspension documentation](https://mastra.ai/docs/agents/human-in-the-loop)
- Local handoff: `/Users/seandearnaley/Documents/brainstrike-3337-handoff-2026-09-26.md`
- Local experiment record: `/Users/seandearnaley/Documents/brainstrike-3337-fresh-proof-2026-09-26.md`
