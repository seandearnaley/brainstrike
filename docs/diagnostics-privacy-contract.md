# Diagnostics Privacy Contract

Brainstrike diagnostics must preserve the product's local-first trust boundary.
Performance telemetry exists to help find slow paths and regressions; it is not a
channel for collecting user content, local workspace identity, or provider
credentials.

This contract applies to background telemetry, diagnostics panels, performance
budgets, regression suites, and future diagnostic exports unless a narrower
feature-specific contract is documented.

## Default Background Telemetry

Background telemetry may collect operational measurements that are useful without
identifying a user's local files, prompts, or content. Acceptable default fields
are:

- durations
- counts
- byte sizes
- process labels
- feature names
- coarse route or surface identifiers
- queue depths, retry counts, and bounded error categories
- cache entry counts, eviction reasons, and residency durations

Telemetry names should describe product surfaces or subsystems, not user data.
For example, `file-explorer.expand.duration_ms` is acceptable; a metric keyed by
a specific local path is not.

## Prohibited By Default

Background telemetry must not collect these values by default:

- raw file paths
- filenames
- prompts
- file content
- embeddings
- provider keys
- raw local database rows
- source snippets, chunks, or generated answers
- stable hashes of user content, filenames, prompts, or file paths

Redaction after collection is not enough for these fields. The default path must
avoid collecting them at the source.

## User-Initiated Diagnostic Export

A user-initiated diagnostic export is different from background telemetry.
Exports may include richer local state only when the user explicitly starts the
export flow and can inspect what will be shared. Export flows must:

- explain which categories of data are included
- exclude prohibited background telemetry fields unless the user explicitly opts
  into that category
- prefer summaries, counts, and timing data over raw records
- provide a local review step before anything leaves the device
- make deletion and regeneration possible without contacting a remote service

The export format should remain useful when sensitive categories are omitted.

## Consent For Data Leaving The Device

Anything leaving the device requires explicit consent unless it is already part
of a user-directed network operation, such as calling a configured model provider
with the user's prompt. Diagnostics upload, support bundle sharing, and remote
telemetry opt-in must be separate choices from normal local app usage.

Consent copy must name the data categories being sent. It must not rely on broad
phrases such as "usage data" when content-adjacent or workspace-adjacent fields
are included.

## Ticket References

Current and planned telemetry work should reference this contract:

- BST-376: tree snapshot bytes, rehydration, flatten, and row-build timing
- BST-400: renderer long-task telemetry with route and feature context
- BST-401: background CPU and wakeup metrics by process
- BST-402: embedding batch bytes, cache residency, and vectors-in-flight telemetry
- BST-403: DB query histograms by feature area

These tickets may add metrics covered by the default allowed list. If a ticket
needs anything outside that list, it must document the consent and export path
before implementation.
