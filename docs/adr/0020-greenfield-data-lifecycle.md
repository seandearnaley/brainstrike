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

At adoption, M3 retained its owner-approved closeout scope and M4 used a separate
integration branch for child/client/history/retrieval parity and obsolete-runtime
removal. That milestone ordering is historical. Since M5 (12 October 2026),
development branches from `main` and merges back to `main`; there is no milestone
stack or continuing main freeze.

This decision does not itself demonstrate removal of compatibility code or cleanup
joins. Removal stays within the existing BST-1935 inventory; this ruling adds no
repository-wide compatibility cleanup campaign. Actual removal preserves
supported fresh-data behavior and resource retirement. Do not delete a failing
behavior test to manufacture green.

The live Architecture Reset milestone and existing tickets define acceptance.
BST-1934 is canceled, not implemented, and no longer blocks client parity or
demolition. This decision authorizes no release or signing.
