# Agent evals

`packages/agent-evals` measures whether the agent finishes coding tasks. Each
task runs through the real standalone CLI host (ADR-0017): its tools,
permission policy, storage and AI SDK loop. A hidden verifier scores the
result, and the metrics come from the host's committed log. No app imports the
package; the `evaluation` domain in `architecture/domain-map.json` has no
dependents.

## Task format

A task is a folder, `packages/agent-evals/tasks/<id>/`:

- `task.json`: `{ id, title, prompt, model, timeoutMs, verify: { command }, cassette? }`.
  The folder name is the id. `model` is a canonical `provider::model`. `cassette`
  is a path relative to the folder.
- `repo/`: the starting workspace.
- `verify/`: the hidden verifier. The runner copies it to `.verify/` only after
  the run ends, so the agent never sees it.
- `script.json`: the scripted model's tool calls, one per step; `{ "parallel": [...] }` makes two or more in one step.

`src/task.ts` decodes all of this with Effect Schema and refuses unknown fields.

## Runner

```sh
pnpm --filter @brainstrike/agent-evals eval [--task <id>] [--mode scripted|replay|live]
```

The command builds the package and its dependencies first. For each task:

1. Copy `repo/` to a temp directory and commit a git baseline.
2. Create a fresh data root and `HOME`. Every eval uses a disposable profile.
3. Start the host with `--workspace <copy>` and run the prompt with
   `run --json --non-interactive`.
4. Approve each pause through the CLI. Default policy holds every write
   (`edit: ask`), and the CLI has no pre-approval flag. A paused run exits 2.
   The runner then calls `interaction respond --decision approve` for each
   pending approval, followed by `attach`, until the run ends. A question,
   plan or network interaction fails the task, because an eval cannot answer it.
5. Read the thread with `threads show` and stop the host.
6. Copy in the hidden verifier and run `verify.command` in the workspace. Exit
   0 means pass.

## Modes

| Mode | Model | Provider egress |
| --- | --- | --- |
| `scripted` | The agent-host `scripted-model` fixture plays `script.json` as `scripted::<id>`. | A loopback boundary that refuses every request. |
| `replay` | The task's `model`, through the real provider SDK. | The task's cassette, served by `createProviderCassetteReplay` through the `*_BASE_URL` knobs. |
| `live` | The task's `model`, with the owner's key. | The real provider. Needs `--live` and `BRAINSTRIKE_EVALS_LIVE=1`, and never runs in CI. |

Scripted mode runs the real standalone platform through a trusted `--platform`
module (`src/scripted-platform.ts`). The platform's trusted model seam
(`createHostPlatform`'s fourth argument) gives the script its own identity, so
`run.started` and every `model.step` name the model that actually ran. No flag,
env var or run input can reach that seam. The task's `model` sets the token
budgets.

Replay without `--task` runs only the tasks that have a cassette, and names the
tasks it left out. `parallel-read` replays the existing
`openai-parallel-tool-calls` provider cassette.

## Scoring and results

A task passes only when every stage is clean. The first failure becomes the
reason, checked in this order:

1. A host error.
2. A refused provider request, including any replay mismatch.
3. A timeout.
4. A run verdict other than `completed`.
5. An unserved cassette exchange.
6. A verifier that did not run or did not exit 0.
7. A `task.json` `expect` the committed log does not meet.
   `parallelCalls: { toolId, atLeast }` needs the model to call that tool at
   least `atLeast` times in one step, so a parallel-read task fails when its
   reads arrive one step at a time, whatever else shares a step.

Metrics come from the committed log, never from CLI output: steps, tool calls
by name, each tool's most calls in one step, input and output tokens, approvals, wall time from `run.started` to
`run.finished`, and the verdict. Each run appends one JSON line per task to
`packages/agent-evals/results/<UTC date>-<mode>.jsonl`, which is gitignored, and
prints a summary table.

## Recording (owner only)

```sh
pnpm --filter @brainstrike/agent-evals record --task <id> --model <provider::model>
```

Recording makes paid provider calls with the key the owner exports in their
shell. Agents never run it, and it refuses to run in CI. It runs the task live
through `startProviderCassetteRecorder`. Then it checks the recording: no home
path or key in the cassette (`providerCassetteFindings`), and a clean pass from
`scripts/secret-scan.mjs`. Finally, it replays the cassette. Only a run that passes,
live and on replay, is kept, with the same verdict, every exchange claimed and
no request refused; a failing run is never a task's canonical replay. Only after these
checks pass does it write `tasks/<id>/cassette.json` and set `cassette` and
`model` in `task.json`. `record.integration.test.ts` proves this path offline:
the recorder forwards to a loopback stand-in that replays a committed cassette,
and the test holds no real key.

## Nightly

`.github/workflows/agent-evals.yml` runs every night on main (08:13 UTC) and on
`workflow_dispatch`: replay mode for tasks with a cassette, then scripted mode
for every task. It uploads the results JSONL as the `agent-evals-results`
artifact, and a red scheduled run files a `nightly-alert` issue in Linear.

## Not yet

- The standalone host has no shell tool, so no task runs a command (BST-2073).
- Only `parallel-read` has a cassette; the owner records the rest with
  `record`.
