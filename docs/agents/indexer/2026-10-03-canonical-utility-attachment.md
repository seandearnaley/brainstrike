# Canonical utility attachment

The actual canonical runtime belongs beside the existing native index engine in
the desktop utility process. Main retains actual authority and capability
objects; serializable identifiers select that captured closure rather than
reopening a path or constructing a second grant.

## Delivery boundary

`IndexerHostManager.attachCanonicalWorkspace` constructs the public
`CanonicalWorkspaceIngestionRuntime` through the existing utility stream and
returns `trigger/cancel/close`. `attachCanonicalCollection` constructs the public
rootless `CanonicalIngestionHost` and source, returning `scan/cancel/close` without
a synthetic lease. `start()` retains the existing `IndexerPort` and additive
`ScopedIndexerPort`. Composition supplies publication callbacks backed by that
same port and its actual receipt owner.

The private protocol validates source/parser/request/watch/catalog/publication
DTOs at both ends. Admission limits are 64 outstanding messages, 64 files per
batch, 16 MiB per source, 10,000 entries per directory and 32 MiB per message.
Authority checks compare actual captured lease root/generation/path and catalog
identities before invoking callbacks. Shared public runtime, parser and writer
implementations are unchanged.

## Causal failures and guards

- The original channel test failed RED with no attachment implementation.
  Cancellation sends a notice while correlation remains owned until a terminal
  reply. A remote failure named AbortError remains a failure; exact owned
  cancellation carries a separate acknowledgement.
- A terminal-response failure test failed RED because settled callback removal
  erased the send rejection. Retain transport errors through the main join and
  notify the lifecycle connection to retire the process. Remember successful
  child close independently so retrying main cleanup does not require a removed
  child runtime. Tests hold actual callback promises during close and remote
  exit, then exercise unsubscribe failure and explicit retry.
- An aggregate error test failed RED because name/message reconstruction erased
  the original publication and cleanup causes. Validated recursive fault DTOs
  preserve aggregate errors and causes in replies and workspace error events.
- The manager test holds admitted retained-source IO, times out a returned scan
  using controlled timers, verifies stopped admission and proves engine close
  waits for that IO to settle.

## Native process proof

The integration fixture builds the same `runCanonicalIndexerProcess` used by the
production Electron entry, with explicit Node IPC as its test endpoint. It runs
the public IndexerConnection, real SQLite writer worker and query-only reader,
full migrated PGlite and production NativeCanonicalCatalog adapter. Actual PG
retained source passes through the reverse channel into the public canonical
OXC parser, exact provided chunks/native plans, full scoped writer manifest and
PG completion. Updating that source replaces lexical search results. Close joins
attachment, reader, writer and process exit with status zero.

This proves the native process composition with controlled receipt callbacks.
It does not qualify actual Electron/main grant/profile construction, hidden
inference, closed-window lifecycle, cross-platform behavior or performance.
The accepted shared runtime at this delivery base is TEXT-only in the immutable TEXT checkpoint; the accepted VECTOR continuation
below attaches the reviewed public contract without a TEXT downgrade.

## Independent review correction

Review of immutable TEXT checkpoint e8743ab92 reproduced a stale-result race:
hold an admitted read, change the actual lease generation, then release the read;
the original parent acknowledged old source bytes successfully. Four RED cases
also cover changed root/path and captured file identity during publication.
An additional RED case replaces the lease object with the same tuple and proves
cleanup must retire the original captured borrow, never its replacement.

The callback boundary now rechecks the same actual lease object and full captured
root/generation/path tuple after awaited work, plus the operation's current
scope/ticket/file inventory predicates before acknowledging success. Authorized
batch loads recheck their input identities before remembering the returned
catalog bindings, preventing an awaited stale result from replacing a newer
capture. Successful downstream parsing/publication/completion cannot follow a
stale acknowledgement. The actual main publication/receipt adapter still owns
authority around already admitted native side effects.

## Connected retirement correction

Independent review found that a blanket live-owner check also blocked original
watch/lease cleanup after replacement; the fake child-close acknowledgement in
the first replacement test missed it. Connected actual public workspace
runtime/parent/child cases reproduce the failure, hold physical unsubscribe,
exercise revocation, and retain genuine failed retirement through explicit retry.

Live work still checks the actual current captured objects before and after
awaited work. Owned unsubscribe, original lease retirement, scan abort and
incomplete finish instead target the retained original capabilities and scope;
they acquire no replacement resource and cannot acknowledge complete readiness.
Child-close failure cannot bypass main's join. Both errors remain visible and the
owner stays retained until explicit retry joins all retirement.

## Accepted VECTOR attachment

The reviewed public shared VECTOR discriminated union is attached through the
same workspace/rootless utility acquisition API. The private transport mirrors
its complete profile, actual native plan, manifest and coverage DTOs with
public-type-checked codecs; no private package import or manufactured production
plan is used. VECTOR generation uses bounded ordered chunks and unique operation
IDs. Main retains the original inference object alongside the catalog,
inventory, publication and lease, checks current ownership around live work,
and cancels/joins the original operation during cleanup even after replacement.
Known already physically joined cleanup is idempotent; foreign/reused IDs fail.
Remote process exit retains main inference until physical settlement; genuine
join failure remains visible and owned for explicit retry. Captured-authority
helpers live in a private module to keep lifecycle/dispatch within the source
file size contract without adding a package or public service boundary.

Causal RED cases reproduce retirement targeting replaced inference and VECTOR
plain-text publication rejecting the public host's explicit syntax: undefined.
The former captures original inference and fences replacement work; the latter
uses the exact optional-undefined DTO. No source-kind fallback is introduced.
The native process proof now covers TEXT TypeScript and VECTOR TypeScript plus
plain-text retained source, with actual saved PG local model metadata, production
profile resolver/inference adapter and controlled document transport. It proves
native returned plans and vectors, complete manifests/coverage, zero additional
inference for covered rescans, changed-source replacement and unique joined
operation IDs. A held document operation observes cancellation while control
remains pending until physical release; the scan then rejects its exact owned
cancellation, PG completion stays absent and native third-version publication is
absent. The final native process joins exit zero. No GPU/model inference or app
acceptance is claimed.

The accepted shared VECTOR runtime currently rereads/parses eligible source on
covered rescans, because its public source inventory does not expose skipped
chunk identities. Native missing-chunk plans avoid repeated inference. This is
an explicit performance limitation, not a qualification result.

### Collection admission and full-scan lifetime correction

The original VECTOR1000 assembled benchmark produced a complete workspace
receipt, then hit the collection's five-second control deadline while the real
scan was still running. The utility subsequently wrote every scoped vector, but
no complete collection receipt reached public readiness; stored counts could
not certify completion. The evidence is retained under
`brainstrike-desktop-acceptance/m2-performance-setup-fixed-vector-1000-20261004T024901Z-96d1afc0`.

The desktop-private control now separates `start-scan` admission from
`join-scan` terminal delivery. The child reserves the exact request and original
runtime promise before ACK, retaining even a fast failure until join. The
manager bounds the ACK using the unchanged request budget and tracks the public
scan through its terminal without a corpus-duration deadline. Close and source
retirement join admitted scan terminals before engine release; physical exit
fences admission and joins retained main IO before rejecting remote work.
Cancellation, close, exit and engine deadlines remain unchanged.

Deterministic manager guards distinguish a withheld ACK from an admitted scan
that outlives the request budget, early close ACK from physical terminal join,
and exit from retained main IO cleanup. Actual connected child/runtime guards
exercise fast receipt and independent failure retention through matching join.

A subsequent exact-head review exposed a missing-ACK race: a fast independent
publication failure could settle before main received admission, leaving the
caller with only its deadline while child retirement assumed a join existed.
The manager now retains an internal join chained from the original admission
promise beyond that deadline. A late independent failure remains observable
through explicit close before engine release; cleanup can then be retried.
A real connected child/runtime guard withholds the ACK, settles an ordinary
publication failure, expires the control budget (and optionally a first close budget), releases the
ACK and requires a still-active explicit close to report the original failure while retaining the engine.

The physical join never consumes retained late faults inside a work promise
that may outlive a caller's close deadline. Attachment close, source retirement,
manager close and destroy report/consume those faults synchronously after their
bounded join succeeds. An expired retirement attempt leaves the fault available
for the next explicit caller before engine release.
