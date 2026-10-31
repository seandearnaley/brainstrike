Ticket: BST-###

The merge queue is the gate: it runs every check on each batch. Run the checks
for what you changed before this PR is ready: Mergify queues a ready PR by
itself once Claude Review has run and every review thread is resolved. To run
the whole gate on it first, keep it a draft with the `full-check` label.

## Change

Describe the problem, resulting behavior, and related Linear identifier.

## Local validation

List the exact commands run on this PR head and their results. State any skipped
checks, platform limitations, or checks that remain unverified.
