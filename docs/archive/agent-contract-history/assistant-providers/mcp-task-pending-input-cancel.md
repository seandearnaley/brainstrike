# Task cancellation while input is pending

The desktop task host and extension registry share their public client bundle.
Task input exposes a host-bound cancellation action inside the consent modal.
Cancellation retires input immediately and waits for an authoritative cancelled
observation before reporting success. Input cancellation and task cancellation
are separate actions.

## 2026-10-03 desktop acceptance (BST-1948)

At consumer head `92bca5cf2c9e1f298362aa6fa0870f2e59a31b85`, the real
desktop run failed before presenting input: `tasks/get` was not registered.
The registry matches request contract objects by identity. The desktop imported
task runtime classes from the separately emitted `mcp-tasks` bundle while the
registry came from `mcp-client`. Source-aliased unit tests concealed that boundary.
Importing the runtime from the existing public `mcp-client` exports restores the
registered identities without changing registry matching.

After correcting the runtime import, the real input dialog appeared, but its
focus trap made the task card outside the modal inaccessible. The dialog's
existing `Cancel` settles an input request; it does not cancel the task. A normal
Playwright click confirmed that no `Cancel task` action existed in the modal.

The presenter now supplies the validated tracked task handle through its private
task binding. Ordinary server input cannot create that authority. The modal uses
the existing `tasks.act` capability and preserves the handle's fences. It remains
mounted when cancellation aborts input, disabling answers and dismissal while
the task action is pending. Failures stay visible and retryable.

The desktop regression uses the public MCP test lab's SDK-backed `tasks-reference`
server and ordinary assistant approval. A transparent loopback relay records
wire requests and holds post-cancel status reads. It proves exactly one matching
`tasks/cancel`, no `tasks/update` for the cancelled task, retired input, and a
nonterminal presentation after the acknowledgement. Releasing status reads then
proves observed cancellation. A second task completes through normal input,
demonstrating that the observer remains usable. The task lifecycle persists its
status before presenting input, but publishes the card projection after awaiting
the interaction handler. During the modal, the card can therefore still show
`working`. An extra pre-cancel assertion requiring the card to show
`input_required` failed and was corrected to use actual modal visibility plus
the live cancellable handle; terminal and wire assertions remain unchanged. The
test owns disposable user data, workspace, server and relay; teardown verifies
released resources.

The initial development build passed this real desktop sequence. This is not
qualification of the later composed candidate or other platforms. Durable logs,
screenshots, wire evidence and build hashes are in the task handoff under
`delivery/evidence/bst1948-input-cancel/`; final candidate results belong there.

## Guards and protocol sources

The integration transplant's normal hook caught a cold-output prerequisite:
the fixture's public `McpLabSession` type could not resolve before the lab was
built. Desktop's Turbo `type-check` and `test:e2e` tasks explicitly build the
lab while preserving their inherited prerequisites. The lab remains absent
from application package dependencies and source aliases; fixture wire and
terminal assertions are unchanged.

- `mcp-task-contract-bundle.integration.test.ts` compiles the actual desktop host
  and executes it in plain Node against built public packages, avoiding Vitest
  source aliases.
- Presenter tests reject foreign task handles and preserve host provenance.
  Settings UI tests cover retirement during cancellation, duplicate clicks,
  missing capability and visible retryable failure.
- `mcp-task-pending-input-cancellation.desktop.test.ts` covers the real desktop
  boundary described above, including the positive input control.
- [Tasks extension specification](https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md)
  defines cancel acknowledgement, authoritative status and input updates.
- [SDK server implementation](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/server/createMcpHandler.ts)
  supplies the reference server's protocol behavior.
