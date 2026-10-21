# BST-2282 follow-up: close the receive set before its final join

Defect density on 2026-10-21, base `3bd9e664a`, reports agent-host runtime 4,
host-lease runtime 4 and agent-host connection 7 fix commits in 14 days (HOT).
The JSON-RPC patch has zero. The Linear nightly-alert inventory contains no
additional socket-retirement failure; BST-2282 is the queue failure.

| Fix | Failure / ownership addressed |
| --- | --- |
| #3565 | Post-reset client/runtime behavior. |
| #3585 | Checked-file and workspace scope consistency at host requests. |
| #3590 | Actionable failures and lost-GPU recovery. |
| #3595 | Replace PGlite with the canonical SQLite/reset owner. |
| #3873 | Preserve the damaged store's typed read-only refusal. |
| #3903 | Recognize leaving owners by refusal code, not message text. |
| #3912 | Cancel and answer admitted requests before destroying sockets. |
| #3925 | Reconsider idle retirement when a startup-held run releases. |
| #3935 | Keep catalog handlers available for typed closing refusals. |
| #4090 | Ready messages replace app-host startup-grace retirement. |
| #4111 | Replace a dispatched-promise snapshot with JSON-RPC drains; retire client admission after an explicit closing refusal. |

The review of #4111 identifies a boundary the earlier regression did not hold:
complete-frame decoding after the initial reader drain, before the last request
dispatch settles. The reader schedules decoding separately from the connection's
dispatch queue. A connection can therefore look empty while that reader still
owns a complete frame. Its drain is not evidence that an open input has retired.

The deterministic proof holds an actual host request, enters close, then holds
a later complete request in the reader's decoder. Release the earlier request
while that decoder remains held. Observe the input fence or physical socket close
to release decoding; require a typed `host.closing` response, never transport loss.
On the base, both macOS and Ubuntu receive `host.connection-lost` after the server
physically closes, rather than `host.closing`. The existing regression continues
to require live refusals while old work joins.

Design: remove the assumption that an early reader snapshot closes receive
admission. Keep input open while dispatched requests join,
then fence socket reads before joining the finite received decode/dispatch tail.
Keep this inside the existing socket retirement owner. No clock, retry, fallback,
new lifecycle state or change to the post-Root host/stop response is needed.
