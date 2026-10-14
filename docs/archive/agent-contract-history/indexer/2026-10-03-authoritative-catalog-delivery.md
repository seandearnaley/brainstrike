# Authoritative canonical catalog delivery

The desktop adapter consumes the public canonical catalog port and actual PG
queries and transactions. Its injected main authority must provide current scope,
saved profile, real identity and native binding/removal acknowledgements. A path,
collection ID or source hash alone grants no read authority. The desktop manifest
declares canonical-ingestion directly and the current lock importer links it.

Preparation retains original source through the existing managed-cache policy,
reuses the registered ID or allocates a real UUID, checks the exact hash, and waits
for the complete native binding inventory acknowledgement. Completion guards that
same source revision. Bounded retained collection reads preserve nullable roots
and paths. Controlled held-operation tests pin cancellation and stale-authority
refusal; real PGlite tests load the full engine extensions and migration ledger.

The first adapter revision deleted rootless records directly and left queued and
running embedding jobs active. The mandatory correction uses exact ID, collection
and nullable metadata targets in the canonical invalidation transaction, including
job cancellation, lease release, metrics and deletion rollback. See the paired
database contract and `database/canonical-record-invalidation.md`.

Delivery consumes reviewed0761 plus mandatory4803 together, retaining their exact
package and adapter source. It proves the catalog seam; it does not establish
actual application grants, hidden inference, utility scans, closed-window behavior
or full native index readiness.
