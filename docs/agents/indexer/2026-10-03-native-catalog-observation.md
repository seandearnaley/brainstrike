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
Only an incomplete manifest receipt for an explicitly different, newer
observed inventory schedules the superseding scan; errors and incomplete
manifests for the current inventory still reject. The superseded receipt stays
incomplete; readiness requires a fresh complete native proof.

The real native negative control physically removes a published row before
verification. The verifier reports that exact missing canonical identity and
activation remains unavailable. No timeout, revision predicate, manifest
membership check, source read, inference path or writer authority is relaxed.

Guard: `apps/desktop/src/__tests__/native-index-catalog-refresh.integration.test.ts`.
