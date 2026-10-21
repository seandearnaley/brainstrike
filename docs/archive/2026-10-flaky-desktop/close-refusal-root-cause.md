# BST-2282: a retirement snapshot is not a transport join

Defect density on 2026-10-21 (14 days, base `586372d54`) reports runtime.ts
(agent-host) 3, connection.ts 7, and runtime.ts (host-lease) 4: all HOT.

The recent changes cover the same admission/retirement boundary:

| Fix | Failure addressed |
| --- | --- |
| #3565 `fdd310f1e` | Post-reset client/runtime behavior. |
| #3585 `12e0da774` | Checked-file and workspace scope consistency at host requests. |
| #3590 `abd78dd82` | Preserve actionable failures and lost-GPU recovery. |
| #3595 `208c3aafb` | Retire PGlite; join the canonical SQLite owner at reset. |
| #3873 `aa44e5d91` | A damaged store must refuse writes with its typed read-only cause. |
| #3903 `44fe78879` | Identify a leaving owner by a refusal code, not message text. |
| #3912 `c253545c2` | Cancel signal-aware requests and write admitted replies before socket destruction. |
| #3925 `53e037252` | A never-attached CLI host must reconsider idle retirement when its last run releases. |
| #3935 `f71a79263` | Keep catalog handlers installed to send typed closing refusals. |
| #4090 `32587b9b4` | Readiness is a message; remove app-host startup-grace retirement. |

The Linear nightly-alert inventory was checked; BST-2282 is a separate queue
failure. Its hosted log records a lost catalog `disconnect-except` request from
registry convergence after `register`, then `read ECONNRESET` on client cleanup.
The registry does not own or close this borrowed client.

Current order: latch closing and start Core retirement; remove discovery; stop
listening; on each socket cancel and snapshot dispatched promises; destroy that
socket once its snapshot settles; join Core/catalog/platform; close store and
release Root. The socket's snapshot excludes a refusal dispatched while an older
request is joining. A concurrent socket with no old request closes immediately.

The deterministic regression holds register, observes the existing server close
boundary, then holds the writer of a new typed refusal. Releasing register lets
the old snapshot settle and destroys the transport with that refusal still
pending. The client receives `host.connection-lost` instead of `host.closing`.
No delay budget can make a snapshot include later messages.

Design: delete agent-host's duplicate dispatched-promise set. The existing
JSON-RPC reader and connection own decoding, queued dispatch and response writes;
join those owners at the existing transport-retirement point. Preserve the
host/stop response identity and its post-Root reply. No deadline, retry or new
lifecycle phase is introduced. Refusals must remain visible until received work
settles; store/Root still close only after the transport join and Core retirement.

## The Linux reproduction also exposes client admission after retirement

The first drain correction alone is insufficient: the original file repeated on
Ubuntu still produced six `read ECONNRESET` and six ended-socket failures in 20
iterations. After the refused list and successful register ACK, restore sends
`disconnect-except` on the same client. The host may now close: its admitted
register has joined. The client nevertheless sends again despite already having
received the terminal `host.closing` refusal. The socket fault then appears both
on that request and on client cleanup. No ordering inside the server can join a
request which the peer has not sent yet.

Client density is also HOT: client-connection.ts has #3590 (actionable failures),
#3595 (canonical catalog routing), and #3949 `cf2f46246` (typed peer-reset writes).
client.ts has #3903 (typed lease refusals), #4090 (owned startup by message) and
#4095 (joined quit). #3949 mapped the resulting EPIPE; it did not retire request
admission when the host explicitly announced retirement.

Remove that continued-admission behavior. One shared request owner for host RPC
and catalog commands retains only an actual typed `host.closing` refusal from
this connection. Subsequent commands return that exact refusal without a wire
write; already-admitted replies continue to join. Other refusals, encoding
failures and transport faults remain their own errors. This is a terminal state
reported by the owner, not an error retry or a guessed liveness state. The new
red test proves the boundary after a held write's ACK and physical host close.
