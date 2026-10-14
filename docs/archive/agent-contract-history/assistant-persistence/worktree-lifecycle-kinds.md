# Worktree lifecycle run-event kinds — evidence

Supports `docs/agents/assistant-persistence.md` §
"WORKTREE LIFECYCLE KINDS". Read this before proposing to change the three worktree kinds, the closed `via` vocabulary, or shell correlation.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

`worktree.created`, `worktree.archived` and `worktree.setup` are additive
`ASSISTANT_RUN_EVENT_KINDS` members, emitted by `worktree-run-events.ts` through
the SAME `recordDesktopAssistantRunEvent` writer (exported for this purpose —
do not add a second INSERT) and therefore under the same documented `if (runId)`
gate as every other main-process writer.

They are emitted ONLY for an operation that happens inside a run. A worktree
created from the Mode chip before the thread's first request has no
`brainstrike_assistant_thread_runs` row to reference (`run_id` is `NOT NULL`
with an FK), and NO orphan row is invented for it: the create sheet reports the
outcome inline, a toast confirms it, and `brainstrike_worktrees` is the durable
record. Writing the same fact into both tables would be a second source of
truth — the argument that kept `tool.approval.resolved` out of the contract.

All three are `NEVER_RUNNING` (status `info`, or `failed` for a failed setup),
so none declares a terminal. `AssistantRunTimeline` needs no change: it renders
`label`/`detail`/`status` and derives only a `lifecycle` colour from the kind
prefix (via `classifyRunEvent` in `tool-visual-classification.ts`, which falls
through to `'lifecycle'` for any kind that isn't `memory.*`/`tool.*`). A kind
missing from `ASSISTANT_RUN_EVENT_KINDS` is REJECTED by `readAssistantRunEvent`
and the row disappears — which is why the contract entry is the first thing to
add.

`worktree.created` carries a `metadata.via` discriminator with a CLOSED
vocabulary (BST-1392), emitted by exactly three sites in
`worktree-run-events.ts`: `'app'` and `'tool'` (`emitWorktreeCreateEvents`,
`worktree-service.ts`'s single `create()`), `'adopt'`
(`emitWorktreeAdoptedEvent`), and `'shell'` (`emitWorktreeShellCreatedEvent`,
the correlator). No new run-event kind was added for any of these: a second
kind would need its own pairing-contract row and a second label vocabulary for
the same fact. `'app'` vs `'tool'` is not a second writer's opinion — the Mode
chip's IPC handler and the `brainstrike.manageWorktree` tool executor both
flow through the ONE `emitWorktreeCreateEvents` emitter, which derives the
breadcrumb from the ledger row's `createdBy` (`'user'` → `'app'`, `'agent'` →
`'tool'`), so the timeline can never disagree with `brainstrike_worktrees`
about who created a worktree. Paired test:
`apps/desktop/src/__tests__/assistant-server/worktree-run-events.test.ts`.

Correlation reads the `executeCommand` TOOL RESULT, never the git-metadata
watcher. `GitInventoryInvalidation` carries `{ gitCommonDir, repositoryRoot }`
with no worktree path, no create-vs-remove discrimination, and a 300–2000 ms
coalescing window — attributing that to a run would be a temporal guess. The
correlator is fire-and-forget: it runs after the result exists and can never
delay or fail the tool call.

A `git worktree remove` run in a shell is reported as a VANISHED ledger row,
never archived: an archive carries a restorable snapshot and a shell removal
produced none. The ghost row's "missing on disk — restore it or archive it"
is the honest surface.

