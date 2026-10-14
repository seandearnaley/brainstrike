# Semantic coverage observation during native scans

The normal root c26 app emitted `NativeCoverageObservationInvalidatedError` from strict singleton coverage at 04:27:06.968 and 04:27:08.653 UTC while the source scan was advancing. Its semantic availability observer called singleton coverage even though the native batch contract already represented ordinary authority/readiness transitions as invalidated observations.

Semantic availability now consumes one scoped coverage batch and validates its atomic status, selected profile, grants, store identity, coverage inventory and counts together. An invalidated batch has no counters or authority: Semantic stays disabled with the neutral verification message. Blocked and independent failures retain their reasons. No stale result is enabled, and strict singleton coverage/search/grep keep their existing rejection behavior.

The existing two-second desktop status poll refreshes availability even when the projected status is identical. That matters because an invalidated coverage read may become current without a readiness change, and coverage counts can advance while a scan remains incomplete. The poll supplies a new observation object; the complete execution identity remains stable, so active query inference is preserved. Existing controller coalescing owns one pending check and a fresh follow-up. No new timer, retry policy, deadline, persistence or authority exception was added.

RED controls reproduced singleton failure instead of neutral invalidation and admission despite a malformed batch inventory. The mounted real provider/controller regression exercises current → invalidated → current across identical incomplete-status polls, with strict singleton coverage configured to fail if used. Existing held inference, authority replacement, late observation and actual failure controls remain.

CI is disabled due to cost; validation must run locally. Focused tests and normal hooks are recorded in the handoff. The coordinator owns final root app demonstration and full regression validation; this scoped repair is not evidence that the full app is green.
