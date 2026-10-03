# ADR-0014: Provider credentials, OAuth and OpenAI response storage

- **Status:** Accepted
- **Date:** 2026-10-02
- **Ticket:** BST-1914; OpenAI storage from BST-1918

## Context

Credentials cross several seams: the agent runtime, Bedrock's bearer key and AWS
credential chain (BST-1350, BST-1353), the provider OAuth engine, which is bound by
the signed `docs/OAUTH_LEGAL_REVIEW_GATE.md`, and the desktop env bootstrap report.
`RequestContext.toJSON` drops functions, so a `custom_fetch` closure placed in a
request context vanishes silently. The ChatGPT-subscription path built each request
as if OpenAI stored it and rewrote it to unstored afterwards, so from the second
tool-calling step it pointed at reasoning that was never stored (BST-1918).

## Decision

- Credentials travel as a direct parameter down the whole call chain and never enter
  a serializable request context. A threaded auth input is authoritative, with no
  fallback to runtime or env key resolution.
- Bedrock precedence is env bearer, stored bearer, env chain, stored chain: a stored
  bearer key outranks an ambient AWS environment.
- The AWS credential chain resolves only where the host injects the chain capability.
  Web never resolves a chain.
- Anthropic subscription OAuth is permanently rejected under the signed legal gate.
- The env bootstrap report carries variable names, file paths, counts and the
  loader's own messages, never a value, prefix, hash or length.
- OpenAI: the API-key path keeps `store: true`. The ChatGPT-subscription path sends
  `store: false`, set before the request is built, with reasoning inline as encrypted
  content.

## Consequences

- A bearer key is explicit and Bedrock-specific, while an AWS environment is often
  set for unrelated tooling; that is why rung 2 outranks rung 3.
- On both OpenAI paths the host drops orphaned reasoning and an aborted step's items,
  and strips another provider's executed tool parts on a switch. An expired stored
  item is a typed error that is never retried; replaying without it needs the user's
  confirmation.
- The `@ai-sdk/openai` 4.0.49 pin was for Mastra's persistence copying an output's
  item ID onto its call. The run log keeps both IDs distinct, and the spike sent no
  duplicate references on 4.0.83.
- The CLI host stores secrets through its `HostPlatform` secret store (ADR-0017); these
  rules apply there unchanged.

## Sources

Contract markers this ADR replaces (line numbers at `43daec7fb`):

- `docs/agents/assistant-providers.md:582` (threading rule), `:653` (auth
  precedence), `:709` (injected chain capability), `:829` (OAuth legal gate), `:862`
  (names only).
- BST-1918 and the architecture reset report (2026-10-01): OpenAI per-provider spike.
