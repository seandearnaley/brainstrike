# The approval UX design and this seam's expressiveness gaps — evidence

Supports `docs/agents/code-execution.md` § "Permission engine relationship".
Read this before moving the network escalation onto the approval channel, or
before designing an incremental output channel, an omission position, read-list
provenance, or a host-computed display-context channel. The contract holds the
rules; this file is the record of why.

The UX design for that gating — the pre-run approval card, the network
escalation, the result surface, and the remember-choice scope — is specified in
`docs/run-python-approval-ux-design-2026-08-01.md` (BST-1070, DESIGN ONLY;
implementation blocked on BST-1067). Its load-bearing ruling: a non-empty
`ExecPolicy.allowedDomains` escalates on the SUSPEND channel, not the approval
channel, because Mastra's `requireApproval` is per-tool and cannot be
conditioned on a single call's arguments — so an approval-channel escalation
would be silently skipped by any session/per-tool grant. That doc also records
four gaps in this seam's expressiveness (no incremental output channel, no
omission POSITION alongside the omitted byte counts, no read-list provenance,
and no channel for host-computed approval display context).
