# Linear triage vocabulary

> **Consumer:** the external `triage` engineering skill. The skill is not
> vendored by this repository; this file maps its canonical roles onto live
> Brainstrike Linear concepts.

## Category roles

| Canonical role | Linear representation |
| --- | --- |
| `bug` | `Bug` label |
| `enhancement` | `Feature` for a new capability; `Improvement` for a change to existing behavior |

## State roles

| Canonical role | Linear representation | Current capability |
| --- | --- | --- |
| `needs-triage` | `needs-triage` label | Available |
| `needs-info` | `needs-info` label | Available |
| `ready-for-agent` | `agent-ready` label | Available |
| `ready-for-human` | `needs-human` label | Available |
| `wontfix` | `Canceled` issue state | Available; no state label is applied |

Before applying a role, verify the label or state still exists in the live
Brainstrike team. A missing representation is an unsupported capability: tell
the maintainer which label is absent and wait for explicit authorization to
create it. Do not substitute a similar label or state.

Each triaged issue carries exactly one category representation and one state
representation. Remove the prior state label when moving between label-backed
states. Moving to `wontfix` removes any state-role label and transitions the
issue to `Canceled` with the triage comment required by the external skill.
When leaving `wontfix` for any label-backed role, first transition the issue
from `Canceled` to `Backlog`, then apply the new state-role label.
