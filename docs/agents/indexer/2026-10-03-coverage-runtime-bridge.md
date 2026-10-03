# Native coverage, runtime and visible bridge — 2026-10-03

Layer atop explicit text commit ea9ed73ae. The browser-safe type-only public
indexing-contract/indexer-client module defines exact status/profile/root
readiness, coverage and native hit DTOs. Grep is supplied by the separate root
owned killable read-only query host, with the existing canonical JS matcher;
regex never runs in the writer utility. Whole-word transformation remains the
existing renderer policy. No mode substitution is introduced.

Coverage validates requested root authority before selecting rows. A real
process RED first found the missing coverage operation. GREEN covers text-only
rows, actual vector backfill, empty scope refusal for vector qualification,
duplicate/unauthorized roots, candidate cap/truncation and live corruption
refusal. Per-row has_vector expectations/root consistency/orphans are checked.
Complete indexed-row vector coverage does not claim complete source scans.
The status DTO requires separately supplied canonical producer scan receipts.

Native search results carry candidatesTruncated/scanLimited/truncated. Lexical
retrieval peeks one extra row per authorized root but retains the prior selected
pool/order. Vector retrieval still uses coarse top100/exact cosine and reports
when authorized vectors exceed that pool. No new scan budget is implied.

The desktop runtime accepts only explicit authoritative DB/profile/root inputs
and caller deadlines. Concurrent identical acquisitions retain one manager and
port; changing authority requires an explicit joined close. Missing/not-ready
getters reject before consumers can spawn. Retirement closes reader admission
and joins readers before writer close/destroy; failed reader cleanup keeps the
same live writer owner and refuses automatic replacement.

Actual Electron44.4.5 proof exercises those runtime getters, repeated acquisition,
configuration refusal, held-reader failure with unchanged live writer PID,
explicit retry/fresh recovery, text/vector/incremental/reopen and ordered reset.
The visible-only preload contract uses canonical manifest channels, both role
and frame authorization, strict no-coercion argument parsing, and the existing
IpcResult error unwrap. Hidden/untracked/foreign-frame senders reject before
parsing or calling capabilities. Hidden preload remains unchanged.

Root owns main/reset registration and canonical model/scan configuration. No
product producer/complete-scan receipt is claimed by this layer. Current renderer
ModelConfig lacks complete revision/dtype metadata; this layer invents none.
CI is disabled due to cost; validation must run locally. No full-app throughput,
quality, additional platform or protective-bound mutation qualification.
