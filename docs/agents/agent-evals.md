# Agent evals

`packages/agent-evals` measures whether the agent finishes coding tasks. Each
task runs through the real standalone CLI host (ADR-0017) with its tools,
permission policy, storage and AI SDK loop; a hidden verifier scores the result
and metrics come from the host's committed log. No app imports the package.

## Task format

A task is `packages/agent-evals/tasks/<id>/` (folder name is the id), decoded by
`src/task.ts` with Effect Schema; unknown fields are refused.

- `task.json`: `{ id, title, prompt, model, timeoutMs, verify: { command }, cassette?, expect?,
  followUps?, inputTokenLimit? }`
  - `model` is a canonical `provider::model`; `cassette` is relative to the folder.
  - `followUps: [{ prompt, probe? }]` are later turns on the same thread, each run once the turn
    before it completed. `timeoutMs` applies to each turn.
  - `probe: { facts }` makes a follow-up a question about earlier turns: its answer must contain
    every fact (any letter case).
  - `inputTokenLimit` pins every run's input budget below the model's own, so the thread reaches
    the compaction trigger on a small workspace.
- `repo/`: the starting workspace.
- `verify/`: the hidden verifier, copied to `.verify/` only after the last turn ends.
- `script.json`: scripted tool calls, one per step; `{ "parallel": [...] }` puts
  several in one step.
  - `answer` is the first turn's final text. `followUps: [{ calls?, answer? }]` scripts each later
    turn, one entry per task follow-up.
  - `summary` is what the scripted model answers a compaction's summarizer with. Without one the
    summarizer fails and the host compacts deterministically.
  - `{ "$repeat": { "text", "times" } }` inside an input stands for the text repeated, so a
    script can send a write large enough to fill a pinned budget.

### Sizing a compaction task

The host decides when a thread compacts; a task only has to get there.

- Compaction is checked before a run's first request, at 90% of the input budget, over an
  estimate of the messages alone. The system prompt and tool definitions (about 6,000 tokens on
  the standalone host) are not in that estimate but do count against the budget.
- The newest turns up to 20,000 estimated tokens are never compacted, so a thread needs more than
  that before anything is droppable.
- One tool result is capped at 3,000 to 6,000 tokens, and old read results are pruned once they
  pass 60,000. Large write arguments are the compact way to grow a scripted thread.
- A thread of mostly reads and command output needs a pin of about 64,000 or more: below that the
  request reaches the budget before the estimate reaches the trigger. `recall-after-compaction`
  pins 30,000 because its bulk is write arguments.

## Runner

`pnpm --filter @brainstrike/agent-evals eval [--task <id>] [--mode scripted|replay|live] [--trials <n>]`
builds first, then per task (`--trials` runs each task that many times, each in a fresh sandbox):

- copies `repo/` to a temp dir with a git baseline, and uses a fresh data root and
  `HOME` (always a disposable profile)
- runs the prompt with `run --json --non-interactive` against `--workspace <copy>`, then each
  follow-up with `run --thread <id>`; a turn that errors, times out or does not complete ends the
  thread there
- answers each approval pause (exit 2) with `interaction respond --decision
  approve` then `attach`, since default policy asks for every edit and command
  - a question, plan or network interaction fails the task
- reads the thread with `threads show`, stops the host, runs `verify.command`;
  exit 0 passes
- a task that pins `inputTokenLimit` loads a trusted `--platform` module in every mode, which
  passes the pin to the standalone platform's trusted composition (no flag or env var reaches it)

| Mode | Model | Provider egress |
| --- | --- | --- |
| `scripted` | agent-host `scripted-model` fixture plays `script.json` turn by turn as `scripted::<id>` | loopback boundary that refuses every request |
| `replay` | the task's `model` via the real provider SDK | the task's cassette via `createProviderCassetteReplay` and the `*_BASE_URL` knobs |
| `live` | the task's `model` with the owner's key | the real provider; needs `--live` and `BRAINSTRIKE_EVALS_LIVE=1`; refuses in CI |

- Scripted mode loads the trusted `--platform` module `src/scripted-platform.ts`.
  The script's model identity enters only through `createHostPlatform`'s trusted
  model seam (no flag, env var or run input reaches it), so `run.started` and every
  `model.step` name the model that ran. The task's `model` still sets token budgets.
- Replay without `--task` runs only tasks with a cassette and names those skipped.
  Only `parallel-read` has one (the shared `openai-parallel-tool-calls` fixture).

## Scoring and results

A task passes only if every stage is clean; the first failure, in this order, is
the reason:

1. host error
2. refused provider request (including replay mismatch)
3. timeout
4. run verdict other than `completed` (the first turn, then each follow-up, named by turn)
5. unserved cassette exchange
6. verifier did not run or exit 0
7. unmet `expect`
   - `parallelCalls: { toolId, atLeast }` requires that many calls of the tool in
     one step
   - `compactions: { atLeast }` requires that many committed compactions on the thread
8. a probe whose answer leaves out a fact

- Metrics come from the committed log, never CLI output: steps, tool calls by name,
  max calls per step per tool, input/output tokens, approvals and wall time, summed over the
  thread's turns, and the verdict of the turn the thread ended on.
- `thread` adds the turn count, compactions (`agentic` or `deterministic`), probes passed of
  probes asked, and `spend`.
  - `spend` is the host's own cost ledger folded over the thread: tokens and cost by usage kind
    (`chat`, `compaction-summary`, `thread-title`, the observer kinds), cache read and write
    tokens, and a total.
  - A cost is null when a call has no list price, as every scripted call has.
- Results append one JSON line per run of a task to
  `packages/agent-evals/results/<UTC date>-<mode>.jsonl` (gitignored) and print a summary; with
  `--trials`, the summary ends with each task's share of passing trials.

## What it cannot measure yet

- Observational memory. The standalone host runs with it off (`platform.ts`), so no eval arm can
  turn it on; only the desktop host resolves an observer model.
- Probe answers in scripted mode. The scripted model's answer is the script's own, so a scripted
  pass proves the plumbing. Recall is measured only in replay or live mode.

## Recording (owner only)

`pnpm --filter @brainstrike/agent-evals record --task <id> --model <provider::model>`
makes paid calls with the owner's key. Agents never run it; it refuses in CI.

- Runs live through `startProviderCassetteRecorder`.
- Rejects a cassette containing a home path or key (`providerCassetteFindings`)
  or failing `scripts/secret-scan.mjs`.
- Replays it; keeps it only if live and replay both pass with the same verdict,
  every exchange claimed and nothing refused.
- Only then writes `tasks/<id>/cassette.json` and sets `cassette` and `model` in `task.json`.
