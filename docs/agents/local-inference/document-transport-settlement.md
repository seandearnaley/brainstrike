# Document transport physical settlement

Supports `local-inference.md` — “Explicit native vector request plan”.

## 2026-10-03 correction

The accepted document renderer owns inference through its real generation promise.
The original main channel released its request and rejected as soon as it sent cancel.
That rejection proved a local interruption, not renderer completion. The native profile
adapter's cancel/join seam awaits `documentEmbeddings(payload, { signal })`, so this
public promise must retain physical ownership on every outcome.

The channel has an opt-in interruption join for documents. It retains the original
pending entry, runtime/request fence, capacity and matching terminal response while
caller abort, timeout or send failure is being joined. Ordinary host channels preserve
immediate release. A joined channel's `rejectAll` is a physical completion/retirement
notification; callers must never use it merely to announce that Stop has started.

A cooperative caller abort gets the existing 10-second Stop window to produce a
terminal document response. Non-cooperation escalates into ordinary Stop with its
unchanged 10-second acknowledgement deadline. Expiry of the existing 60-second
request deadline or cancel delivery failure enters Stop immediately. Shutdown uses
3 seconds even when an ordinary Stop is already underway; reset retains 30 seconds.
These timer expiries request retirement and never substitute for a physical ack.
Forced document retirement observes the actual owned window close/renderer exit
before completion; a destroyed flag or successful destroy call alone is insufficient.
A failed destroy keeps the request pending and owner reachable, reports the failure,
and awaits real retirement rather than claiming completion. Replacement admission
joins the active Stop and forced retirement.

Document cancellation creates a specific error code on the hidden renderer's exact
abort reason. Existing error serialization carries it on the terminal error envelope;
no cancel ACK or new IPC message is invented. An unrelated `AbortError` remains an
independent failure. Joined cancellation preserves the caller's original reason,
including non-Errors; terminal, delivery and retirement failures remain aggregated.

Guards: `embedding-host-document-settlement.test.ts` holds terminal completion,
Stop acknowledgement and forced close independently; it covers stale identities,
synchronous cancel response, timeout/delivery faults, independent failure evidence,
reset/restart/dispose, shutdown's shorter bound and replacement admission.
`embedding-host-document-runtime.test.tsx` holds renderer generation and proves no
terminal response before physical settlement. `embedding-host-shared.test.ts` checks
the existing serialized cancellation-code envelope. Shared channel and manager
regressions preserve other hosts' behavior.

These local unit controls qualify transport ownership. They do not qualify actual
model/GPU performance, memory reclamation, desktop app composition or other platforms.

## 2026-10-03 review correction

Independent review found two missing causes: a failed destruction retry was logged
without joining the public error, and destruction rejected documents before Stop
added its preceding failure. The physical boundary remained held in both cases.
Retirement now shares one joined promise and failure list. The initiating Stop or
reset cause enters that list before destruction; each failed retry and renderer exit
adds to it while the owner remains pending. Actual close/exit publishes the completed
failure outcome to documents and every retirement waiter, preserving caller reasons.
The causal tests exercise Stop plus destruction failure and failed retry, both with
and without caller abort, and renderer-exit callback ordering. Existing deadlines,
identity/capacity fences and physical retry behavior are unchanged.
