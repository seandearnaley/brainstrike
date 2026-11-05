# Linear triage vocabulary

Maps the external `triage` skill's roles (not vendored here) onto Brainstrike Linear labels and states.

| Role | Kind | Linear representation |
| --- | --- | --- |
| `bug` | Category | `Bug` label |
| `enhancement` | Category | `Feature` (new capability) or `Improvement` (change to existing behavior) |
| `needs-triage` | State | `needs-triage` label |
| `needs-info` | State | `needs-info` label |
| `ready-for-agent` | State | `agent-ready` label |
| `ready-for-human` | State | `needs-human` label |
| `wontfix` | State | `Canceled` issue state; no state label |

- Before applying a role, check the label or state still exists in the live team.
  - If it's missing, tell the maintainer which one and wait for authorization to create it. Never substitute a similar label or state.
- A triaged issue carries exactly one category and one state.
  - Moving between label-backed states removes the previous state label.
  - Moving to `wontfix` removes any state label and moves the issue to `Canceled`, with the triage comment the skill requires.
  - Leaving `wontfix` for a label-backed state: move the issue from `Canceled` to `Backlog` first, then apply the label.
