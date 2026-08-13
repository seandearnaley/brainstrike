# BST-1251 — search-policy-v1 paired pilot (control vs signal injection)

Phase 2B of the recursive self-improvement series (BST-1240/1241 → BST-1250).
Protocol per the 2026-08-11 self-inspection, corrected for the substrate
findings: BST-1246 (ripgrep degradation) and BST-1247 (telemetry substrate
split) must be in the build under test, and the **control arm doubles as the
post-fix baseline re-measurement**. If the clean (engine-healthy) waste in the
control arm is already small, the intervention arm is not worth running —
record that and close (a legitimate outcome per the ticket).

## Design

Paired tasks across two variants — same model + provider, same code revision,
same prompts, same mounted root, fresh thread per task:

| arm | `variant` | self-improvement signal (BST-1241) |
| --- | --- | --- |
| control | `control` | OFF |
| intervention | `injection` | ON |

- `experimentId`: `search-policy-v1` for both arms, set (with the variant) in
  Settings → Self-improvement signal → Experiment enrollment before each arm.
  Every run's treatment row then records the arm (BST-1250; verify via the
  `experiment-outcome-correlation` lens).
- Tasks: [`pilot/bst-1251-tasks.json`](pilot/bst-1251-tasks.json) — 20
  workspace-search questions, each with a single ground-truth file verified
  against the revision under test. The prompt is the task `question` plus the
  shared `answerInstruction` (the `ANSWER: <path>` final-line contract).
- Labeling: every run is graded by the Stop hook
  [`pilot/verdict-hook.mjs`](pilot/verdict-hook.mjs) (run-outcome
  `source='hook'`, no manual thumbs). The driver arms one task per run by
  writing `current-task.json` into the hook's state directory; the hook grades
  the run's `assistant_message` (last `ANSWER:` line must match every
  `answerPatterns` regex) and stays silent for any other thread.

Register the hook globally (no approval needed for `~/.brainstrike/hooks.json`;
remove it after the pilot):

```json
{
  "Stop": [
    {
      "type": "command",
      "timeout": 15000,
      "description": "BST-1251 pilot verdict",
      "command": "node /abs/path/to/docs/tool-token-efficiency-2026-08-07/pilot/verdict-hook.mjs /abs/path/to/state-dir"
    }
  ]
}
```

## Metrics (from `brainstrike_tool_call_telemetry`, post-BST-1247 columns)

Primary, computed per arm over the arm's exact run window:

- task success rate (hook verdicts, via the correlation lens)
- genuine truncation rate: `truncated` among **engine-healthy** search calls
  (`engine NOT IN ('js-walk','skipped') AND NOT scan_limited`)
- genuine zero-match rate, same denominator
- model-facing search chars per successful task

Guardrails: failed tool calls, diagnostic error/warn counts, substrate
degradation rate (must be ~0 in both arms or the comparison is void), wall
clock per task.

**Gate rule (pre-registered):** if the control arm's genuine truncation rate
and genuine zero-match rate are both under 10% and search chars per successful
task is under 50k, the substrate fixes already removed the waste the
intervention targets — record the numbers, skip the intervention arm, close
BST-1251 as "baseline clean, experiment unnecessary". Otherwise run the
intervention arm and compare per the success criteria in the ticket
(non-inferior success, −20–25% search chars, no guardrail regressions).

## Results

_Appended after execution._
