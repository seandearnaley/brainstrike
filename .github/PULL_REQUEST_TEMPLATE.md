Ticket: BST-###

The merge queue is the gate: it runs every check on each batch, and Mergify
queues every ready PR. Run the checks for what you changed before it is ready.
To run the whole gate on this PR first, keep it a draft with the `full-check`
label until that run passes.

## Change

Describe the problem, resulting behavior, and related Linear identifier.

## Local validation

List the exact commands run on this PR head and their results. State any skipped
checks, platform limitations, or checks that remain unverified.
