# Agent evals

`packages/agent-evals` measures whether the agent finishes coding tasks. Each
task runs through the real standalone CLI host (ADR-0017) with its tools,
permission policy, storage and AI SDK loop; a hidden verifier scores the result
and metrics come from the host's committed log. No app imports the package.

## Task format

A task is `packages/agent-evals/tasks/<id>/` (folder name is the id), decoded by
`src/task.ts` with Effect Schema; unknown fields are refused.

- `task.json`: `{ id, title, prompt, model, timeoutMs, verify: { command }, cassette?, expect? }`
  - `model` is a canonical `provider::model`; `cassette` is relative to the folder.
- `repo/`: the starting workspace.
- `verify/`: the hidden verifier, copied to `.verify/` only after the run ends.
- `script.json`: scripted tool calls, one per step; `{ "parallel": [...] }` puts
  several in one step.

## Runner

`pnpm --filter @brainstrike/agent-evals eval [--task <id>] [--mode scripted|replay|live]`
builds first, then per task:

- copies `repo/` to a temp dir with a git baseline, and uses a fresh data root and
  `HOME` (always a disposable profile)
- runs the prompt with `run --json --non-interactive` against `--workspace <copy>`
- answers each approval pause (exit 2) with `interaction respond --decision
  approve` then `attach`, since default policy asks for every edit and command
  - a question, plan or network interaction fails the task
- reads the thread with `threads show`, stops the host, runs `verify.command`;
  exit 0 passes

| Mode | Model | Provider egress |
| --- | --- | --- |
| `scripted` | agent-host `scripted-model` fixture plays `script.json` as `scripted::<id>` | loopback boundary that refuses every request |
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
4. run verdict other than `completed`
5. unserved cassette exchange
6. verifier did not run or exit 0
7. unmet `expect`
   - `parallelCalls: { toolId, atLeast }` requires that many calls of the tool in
     one step

- Metrics come from the committed log, never CLI output: steps, tool calls by name,
  max calls per step per tool, input/output tokens, approvals, wall time
  (`run.started` to `run.finished`) and verdict.
- Results append one JSON line per task to
  `packages/agent-evals/results/<UTC date>-<mode>.jsonl` (gitignored) and print a summary.

## Recording (owner only)

`pnpm --filter @brainstrike/agent-evals record --task <id> --model <provider::model>`
makes paid calls with the owner's key. Agents never run it; it refuses in CI.

- Runs live through `startProviderCassetteRecorder`.
- Rejects a cassette containing a home path or key (`providerCassetteFindings`)
  or failing `scripts/secret-scan.mjs`.
- Replays it; keeps it only if live and replay both pass with the same verdict,
  every exchange claimed and nothing refused.
- Only then writes `tasks/<id>/cassette.json` and sets `cassette` and `model` in `task.json`.
