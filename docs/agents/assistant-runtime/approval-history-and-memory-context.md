# Approval history and working-memory context

Supports `assistant-runtime.md` § "PERMISSION ENGINE (TOOL APPROVAL)" and
§ "ACTIVITY GROUPS"; background context ownership is in `assistant-subagents.md`.

## 2026-09-27 regression after #3338

The 20:40:56Z debug pack records eight consumed delegated decisions. A later
child-view click was rejected as stale at 20:35:45Z. The screenshots show an
Approved chip with enabled controls. `useApprovalNoticeState` explicitly unlocked
a host answer when its containing response became incomplete; an old test required
that behaviour. This confused decision admission with the rest of the run's outcome.
A host answer now remains authoritative; unacknowledged transport failures remain
retryable. Expanded answered history preserves arguments without approval buttons.
The root-owner subscription test covers both error and cancellation in a child view.

The UI also rendered one pause as a tool activity box, a run event, and a card.
A valid card now replaces its own paused tool and event chrome in that message.
Foreground child cards retain their conversation controls without the redundant
waiting wrapper. Reasoning and execution results remain chronological. An event without a card stays
visible, with historical wording rather than an obsolete request for attention.

The final root leg `run-f2362106-6437-4fe7-b602-892eeba7a284` recorded 38
`updateWorkingMemory` starts and two canvas starts over 40 steps, then user Stop.
The background-results processor re-created the same user-role context with a new
timestamp every step. Native assistant rows can span steps, so that context appeared
after each successful memory result. The correction anchors context to its owning
input, preserving that anchor across pruning. No tool, memory feature, step budget,
agent loop or Mastra patch is disabled or replaced.

Reproduction: `active-background-results-processor.spec.ts` fails prompt ordering;
`active-parent-background-results.integration.spec.ts` uses real Mastra/PGlite and
working memory with a scripted provider sensitive to user/tool chronology. Before
the fix, both initial and continuation cases wrote memory four times (test cutoff);
afterward both write once and return the report, with results retained. This proves
the malformed prompt and correction; it does not promise a stochastic model can
never independently repeat a tool. Existing provider compatibility warnings and
workspace-path failures in the export are separate from these demonstrated causes.
