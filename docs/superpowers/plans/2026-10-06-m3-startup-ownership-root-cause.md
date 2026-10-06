# M3 startup ownership: third-repair design checkpoint

Status: findings #1 and #6 reproduced locally at 11:09 UTC; implementation paused for Sean's decision under root AGENTS working rule 3. Candidate remains draft #3543 on M2. Both startup changes remain out of the candidate.

## Incident and repair count

The same startup ownership class has already received two repairs: 5087308 acquired the SQLite root before constructing a platform, so a losing starter cannot create unowned capabilities; 9ac19ff retained the store and partially restored actors when startup cleanup rejected. The consolidated review now identifies a third gap: the generic Node spawner SIGTERMs every not-ready process, while the agent process installs cooperative signal handlers only after startup succeeds. A startup failure retaining a root-writing child therefore reports failure and then loses its parent/root owner to the launcher. A surviving descendant can continue writing after another process claims the stale root.

The two earlier fixes covered local acquisition and rejection, but the process protocol still has only ready/failed states. The launcher interprets all failures as disposable. Resource ownership crosses that boundary without an explicit retained-owner outcome, and startup cancellation has no cooperative owner installed before capabilities are acquired. Joining only the starter PID cannot prove descendant cleanup.

The ordinary Node spawner repro produced starter PID 6841 (start 11:09:42 UTC) and root-writing descendant PID 6849 (start 11:09:43 UTC). After startup failure the starter was gone, the descendant was alive, and a second StateStore acquired the temporary root. Fixture teardown joined both identities. The publication-window repro acknowledged a real SDK approval run while host.json rename acknowledgement was held; after the last client left, another authenticated client was refused because idle shutdown had already begun. Both regressions are quarantined under owner-held BST-1977, opt-in with `BRAINSTRIKE_M3_STARTUP_OWNERSHIP_REPRO=1`; they currently fail. Logs: `/tmp/brainstrike-m3-review-startup-repros.log`; physical receipt: `/tmp/brainstrike-m3-review-startup-ownership-repro.json`.

## Proposed design decision

Keep one physical startup owner from process entry through terminal joined cleanup. Install cooperative cancellation before acquisition. Give the existing startup protocol an explicit retained-ownership failure outcome, containing no new durable ID or credential; callers must return the failure without killing that owner or publishing another host. The owner fences further work and joins acquired descendants. A rejected join retains the process, SQLite lease, and diagnostic resource handles, rather than fabricating cleanup or retrying. Ordinary failed startup may exit only after complete physical cleanup is demonstrated. Existing timeout values and policies remain unchanged.

Acceptance needs an ordinary launcher/CLI process test with a malformed durable row and a real root-writing descendant, held and rejected cleanup, cancellation during acquisition, and a second-owner attempt. Capture parent and descendant PID/start identities. Prove the child has exited before a released lease permits a new owner; for failed cleanup prove the lease stays live and another owner is refused. Fixture cleanup must explicitly join every tracked process.

Sean decision required: approve this startup ownership design, or specify the owning process and failure protocol. No third startup ownership patch has been retained in the candidate. The publication-window retention race belongs to this same startup ownership design checkpoint. The existing lease retention primitive must also become available before root restoration and socket admission, without adding a second counter or a delayed transfer of ownership.

CI is disabled due to cost; validation must run locally. These are failing defect demonstrations, not successful startup acceptance.
