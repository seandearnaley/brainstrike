# Catalog observation and reconciliation ownership

Track the catalog inventory already observed for invalidation independently of
the publication owner's complete source proof. Repeated reads of that inventory
join the same reconciliation without invalidating its finishing scan. A newer
inventory invalidates affected scopes, supersedes the previous scan, and needs
its own complete native manifest. A failed current manifest remains a failure.

## Evidence

The actual TEXT campaign on product `31769f127916ad14cfda60d391f96b92ea690e8d`
and harness `b87ddfb94ffa233eedcb448c68de99b7d8c93152` passed initial mounted
and collection readiness and visible search, then failed the first retained
addition. The trace contains a manifest-mismatch and later unavailable reads;
it does not expose the native mismatch subtype. That app observation alone
does not establish whether native inventory or publication revision failed.

A controlled production-class probe distinguished those outcomes: one read
completed the addition; a repeated read while verification was held rejected
the same complete manifest because publication's mutation revision changed.
The activation compared each observation with its last completed scan, so it
invalidated the same pending catalog change again. The strict publication
revision predicate correctly refused that receipt, and activation latched a
terminal scan failure.

The regression drives production activation, runtime and publication against
the real native engine. It holds delivery of the actual complete manifest and
repeats read acquisition. On the prior product the repeated-read case returns
manifest-mismatch while the one-read control completes. Both native proofs
have empty missing, changed and unexpected lists. A second catalog addition
during the held finish also exposes the prior terminal-failure latch.

Observation now records its inventory before invalidation and source
scheduling. Complete proof remains exclusively in canonical publication. A
joining acquisition waits for the existing collection reconciliation without
requesting another scan. Initial scan admission also observes its inventory.
The d111 correction attempted to schedule a superseding scan after an
incomplete receipt for a newer observed inventory. Review found that this
branch is unreachable through the public host, which rejects every incomplete
receipt. Its initial native fixture returned that receipt directly and did
not exercise the actual host/channel boundary; the correction below replaces
that fixture and ordering.

The real native negative control physically removes a published row before
verification. The verifier reports that exact missing canonical identity and
activation remains unavailable. No timeout, revision predicate, manifest
membership check, source read, inference path or writer authority is relaxed.

Guard: `apps/desktop/src/__tests__/native-index-catalog-refresh.integration.test.ts`.


## Actual host boundary and queued ordering correction

Bounded review confirmed that d111 closes the repeated stable-read defect,
but the public `CanonicalIngestionHost.scan()` rejects an incomplete receipt;
the utility sends a fault instead of the receipt. The actual-host regression
uses real `CanonicalUtilityParent`/`CanonicalUtilityChild`, public ingestion
host, OXC parser and native engine, with controlled catalog persistence. On
d111 it passes the stable controls and rejects the newer-inventory case at
that real fault boundary.

Queue the newer inventory while the existing collection scan owns completion.
The queued observation masks affected scope readiness; it does not change the
old publication revision or native bindings. Read acquisitions that would
replace bindings join this owned reconciliation. Once the old scan and its
strict receipt physically settle, the same owner loads the latest catalog,
invalidates affected publication proofs, clears the queued gate only after
invalidation, and binds/scans the next inventory. After joining, the read
rechecks catalog observation so a change arriving at the end of the owner
cannot lose its reconciliation. Identical current reads retain nonblocking
progress; a queued reversion joins and clears without unnecessary publication.

Held native verification proves the old complete manifest retains its original
one-file binding ACK. A held next two-file manifest proves synchronous
`getReadiness`, asynchronous `getSearchAuthority`, and visible native `status`
stay gated until the newest full proof completes. Every old and new host scan
returns a complete receipt; no incomplete host result is normalized. Actual
missing-row and genuine aggregate verification failures remain terminal with
or without queued inventory, preserving independent errors and cause through
the private channel. The host, publication predicate, runtime and transport
APIs are unchanged; no message/name matching, fault reinterpretation, retry,
new controller, timeout increase or fallback is introduced.
