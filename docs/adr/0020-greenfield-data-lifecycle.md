# ADR-0020: Greenfield data lifecycle; no legacy-data migration

- **Status:** Accepted by Sean
- **Date:** 2026-10-10; reaffirms the owner ruling of 2026-10-09
- **Scope:** Architecture Reset M3–M6; BST-1934 canceled

## Decision

Brainstrike is a greenfield app with no users. The new architecture starts fresh.

- **Not implemented:**
  - legacy database conversion;
  - imported old threads or child results;
  - read-only old-thread compatibility;
  - memory, credential, approval or task imports;
  - inferred old identities or conversion-loss notices;
  - migration rollback or populated old-schema upgrade qualification.
  - No six-week compatibility period or switch-back gate delays removal of the obsolete runtime.
- **Supersedes** contrary migration requirements in older ADRs, contracts, milestone tickets and
  plans. Dated receipts remain historical evidence, not a requirement to reproduce old data or
  support another storage format.
- **Still required:**
  - The current schema initializes correctly.
  - Current-format data created through the supported runtime survives reopen, replay,
    interruption and recovery.
  - Thread deletion, factory reset, privacy and resource ownership.
  - Loaded tests may populate disposable fresh profiles with current runtime-shaped data;
    greenfield does not mean testing empty databases only.
- **Allowed:** existing DDL, schema-version checks and ledgers may remain as schema-construction
  machinery. Their presence does not require legacy backfills, model/preference-ID remapping or
  old-version upgrade tests.
- **Separate capabilities, not removed by this decision:** public import/export of the current
  format (later removed on its own, [ADR-0011](0011-run-log-and-state-store.md) 2026-10-31
  amendment), external provider/MCP protocol compatibility, and derived-index rebuilds.
- **Unsupported developer data** is not silently converted, repaired or deleted. This grants no
  access to credentials or Sean's protected profile, and no automatic reset. Qualify with
  disposable profiles and fake keys.

## Delivery boundary

- At adoption, M3 kept its owner-approved closeout scope and M4 used a separate integration branch
  for child/client/history/retrieval parity and obsolete-runtime removal. That ordering is
  historical.
- Since M5 (12 October 2026), development branches from `main` and merges back to `main`; there is
  no milestone stack or main freeze.
- This decision does not itself demonstrate removal of compatibility code or cleanup joins.
  - Removal stays within the existing BST-1935 inventory; no repository-wide compatibility cleanup
    campaign is added.
  - Removal preserves supported fresh-data behaviour and resource retirement. Do not delete a
    failing behaviour test to manufacture green.
- The Architecture Reset milestone and its tickets define acceptance. BST-1934 is canceled and no
  longer blocks client parity or demolition. This decision authorizes no release or signing.
