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

## Results (2026-08-13)

**Decision: the pre-registered gate fired — intervention arm skipped, BST-1251
closed as "baseline clean, experiment unnecessary".**

Execution: commit `ebc0b32ce` (post-BST-1246/1247/1250 main), desktop app,
model `anthropic / claude-sonnet-5` (thinking off), fresh profile, this repo
mounted as the only root, **workspace indexing blocked** (fresh profile, no
embedding set) so every search ran the live path — the exact substrate under
test. Control arm: 20/20 tasks, fresh thread each, verdicts 100% hook-sourced
(`source='hook'`), window 2026-08-13T19:23:11Z → 19:28:56Z, 9–21 s per task.
Two pre-arm smoke runs were deleted from the evidence tables before the arm.

Control-arm telemetry (post-BST-1247 substrate columns):

| metric | value | gate |
| --- | --- | --- |
| task success | 20/20 (100%) | — |
| grepSearch calls, engine=`ripgrep` | 32/32 (zero `js-walk`, zero `scan_limited`, zero `candidates_truncated`) | substrate ~0 degraded ✔ |
| genuine truncation (engine-healthy) | 1/32 (3.1%) | < 10% ✔ |
| genuine zero-match (all search calls) | 3/36 (8.3%; glob 2/4, grep 1/32) | < 10% ✔ |
| search chars per successful task | ~1,400 (28,006 / 20) | < 50,000 ✔ |

The self-inspection's numbers ("98.8% truncated") were an artifact of the
conflated flag plus the broken ripgrep substrate. With BST-1246 (ripgrep
healthy) and BST-1247 (truncation = output clipping only), the model's actual
search behavior on this suite shows ~3% truncation and ~1.4k chars/task —
there is no meaningful model-controllable waste left for signal injection to
reduce, and success is already at ceiling.

**Machinery validation (1 probe run, not an arm):** with the profile enrolled
as `search-policy-v1 / injection` and the signal preference ON, the run's
treatment row recorded `injection_status='no_waste'`, `signal_injected=false`
— on a clean telemetry window the injector correctly declines to inject. The
attribution seam (BST-1250) recorded every run: 20× `control/preference_off`,
1× `injection/no_waste`, all labeled, queryable via the
`experiment-outcome-correlation` lens.

Caveats: single machine/profile; Claude Sonnet 5 rather than the GPT-5.x that
produced the original telemetry (arms would have been internally comparable;
absolute rates may differ by model); fixed 20-task suite rather than organic
workloads; indexing disabled (live-only search). Re-run this pilot if a future
baseline on organic workloads shows genuine (engine-healthy) waste above the
gate thresholds — the suite, hook, and enrollment plumbing stay ready.
