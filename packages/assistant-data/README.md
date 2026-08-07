# @brainstrike/assistant-data

Renderer-safe assistant persistence, thread state, grouping, and cost-tracking
data for Brainstrike. The package depends on database and contract layers and
does not depend on app-shell or Brainstrike UI packages.

Public exports:

- `@brainstrike/assistant-data`: repositories, stores, memory-resource helpers,
  suspended-run discovery, cumulative/cross-root usage, and auth headers.
- `@brainstrike/assistant-data/cost-tracking`: daily-spend and run-ledger data
  hooks plus model pricing.
