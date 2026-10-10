# ADR-0020: Greenfield data lifecycle; no legacy-data migration

- **Status:** Accepted by Sean
- **Date:** 2026-10-10; reaffirms the owner ruling of 2026-10-09
- **Scope:** Architecture Reset M3–M6; BST-1934 canceled

## Decision

Brainstrike is a greenfield app with no users. The new architecture starts fresh.
Do not implement legacy database conversion, imported old threads or child
results, read-only old-thread compatibility, memory/credential/approval/task
imports, inferred old identities, conversion-loss notices, migration rollback or
populated old-schema upgrade qualification. No six-week compatibility period or
switch-back gate delays removal of the obsolete runtime.

This ruling supersedes contrary migration requirements in older ADRs, contracts,
milestone tickets and plans. Dated receipts remain historical evidence, not a
requirement to reproduce old data or support another storage format.

The current schema must initialize correctly. Current-format data created through
the supported runtime must survive reopen, replay, interruption and recovery;
thread deletion, factory reset, privacy and resource ownership remain required.
Loaded tests may populate disposable fresh profiles with current runtime-shaped
data. Greenfield does not mean testing empty databases only.

Existing DDL, schema-version checks and ledgers may remain schema-construction
machinery. Their presence does not require legacy backfills, model/preference-ID
remapping or old-version upgrade tests. Public import/export of the supported
current format, external provider/MCP protocol compatibility and derived-index
rebuilds are separate capabilities and are not removed by this decision.

Unsupported developer data is not silently converted, repaired or deleted. This
decision grants no access to credentials or Sean's protected profile, and no
automatic reset. Use disposable profiles and fake keys for qualification.

## Delivery boundary

M3 retains its owner-approved closeout scope. M4 starts on a separate integration
branch from the demonstrated M3 head. M4 completes child/client/history/retrieval
parity and removes the obsolete runtime; it does not migrate data. Existing
compatibility code and cleanup joins are not claimed removed by this document.
Removal stays within the existing BST-1935 inventory; this ruling does not add a
repository-wide compatibility cleanup campaign. Any actual removal must preserve
supported fresh-data behavior and current resource retirement. Do not delete a failing behavior test to manufacture green.

The live Architecture Reset milestone and existing tickets define acceptance.
BST-1934 is canceled, not implemented, and no longer blocks client parity or
demolition. Main remains frozen; this decision authorizes no release or signing.
