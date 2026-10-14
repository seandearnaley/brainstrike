# Retired run-event kinds — evidence

Supports `docs/agents/mastra-boundary.md` § "RESOLVED CONTRACT MAINTENANCE". Read
this before proposing a backfill for the retired `context.*` run-event kinds.


BST-909 removed the never-emitted `context.budget`, `context.prepared`, and
`context.selection` kinds from the closed run-event union. The inbound guard
rejects those retired strings, and informational timeline coverage uses the
real `hook.notice` kind instead of legitimizing a fabricated persisted event.
Repository history from their introduction in `33799e0fe` through the contract
move and inbound-guard adoption shows the strings only in the declaration and a
fabricated UI fixture, never in an emitter or persistence write. They therefore
never reached durable run-event rows, so no data migration or backfill is
required; adding one would mutate local-first user data without evidence.

