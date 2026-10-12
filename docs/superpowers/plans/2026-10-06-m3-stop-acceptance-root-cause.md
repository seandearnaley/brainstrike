# M3 Stop acceptance: third-repair design checkpoint

Status: consolidated re-review residual B; implementation paused for Sean's decision under root AGENTS working rule 3. The candidate stays draft #3543. This is a separate decision from the already-paused startup ownership findings #1/#6; the integrator has not requested approval again.

## Incident and repair count

9ac19ff first repaired repeated Stop returning a cached logical success before retained physical cleanup had succeeded. 53d074e then repaired failed Stop-command persistence leaving native work running: cancellation and physical joining now occur even when the append fails, and active-run completion observes the acceptance failure. The reviewer now finds the third gap in that same Stop failure-latching class. If the run already completed, its task/owner/completion promises have resolved. A rejected Stop append is retained in stopAcceptance, but the repeated Stop path joins only those resolved promises; finish's terminal fast path never observes acceptance. The caller receives success, no command.accepted row exists, and another method can reuse that commandId.

The cause is split proof ownership: physical run completion and command acceptance failure are independent facts, but the fast paths infer one from the other. The admission queue's identity map records only successful durable commands. Stop has partial failure state on the run, while command identity belongs to the command owner. A completed run does not make a failed Stop command successful.

## Proposed design decision

Make HostCore's existing command owner retain one attempted command identity and its outcome for the process lifetime, including acceptance rejection. A repeated request must join physical cleanup and observe the original command acceptance outcome independently of run terminal status. Conflicting method/input reuse must be refused before any other writer or effect starts. Keep commandId as the sole existing command identity; no new durable ID, retry, alias, second writer or successful acknowledgement is proposed. A failed persistence write remains a failure. Define restart semantics explicitly from existing durable accepted rows: a failed uncommitted attempt cannot be invented after restart.

Acceptance: real SQLite fixture, completed SDK run, injected Stop append rejection, repeated Stop and conflicting thread/start reuse of the same commandId. Verify the original failure is returned, no later command/effect is accepted under that ID, physical resources are joined, and active-run behavior stays intact. Also cover accepted Stop with rejected physical cleanup, simultaneous/repeated callers, and genuine storage failure rather than only a selective port fault.

Sean decision required before a third Stop acceptance repair. No Stop implementation change has been applied for residual B. An opt-in failing repro remains an OPEN defect; a default skip is not an approved quarantine waiver or full-suite pass.

CI is disabled due to cost; validation must run locally.
