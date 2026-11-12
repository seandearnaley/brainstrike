# Assistant providers and MCP

The host admits concrete models and executable tools; clients submit non-secret intent. Provider auth, transcript ownership and transport negotiation are separate boundaries.

## Catalog and requests

- Provider and model rows belong to [the catalog](../../packages/assistant-contract/src/provider-catalog.json), with strict validation and accessors in the same package.
  - Derive authentication and capability behavior from registry metadata, never provider-name heuristics.
  - Catalog object keys are alphabetical at every depth. Biome's `useSortedKeys` doesn't reach JSON keys and no check enforces it, so keep the order by hand. Row order is curated, not sorted.
  - A row states image support once, in `inputModalities`; the parser sets `vision` from it. Every row lists the pages its facts were read from in `sources`, with the day each was read; `_note` keeps the prose provenance.
- Pricing and model limits belong to the route that serves and bills the request. Provider-reported cost is authoritative; catalog rates are estimates.
  - The ledger reads OpenRouter's bill from each committed step's usage (`raw.cost`; a BYOK call adds `cost_details.upstream_inference_cost`). Only a call no provider billed is priced from the catalog.
- Prepare provider history through [the shared request boundary](../../packages/agent/src/provider-request.ts).
  - Keep executed tool provenance and OpenAI call/output identities distinct.
  - Native OpenAI tool-search history needs its declared `openai.tool_search` provider tool at the SDK edge; a function named `tool_search` is a different tool ([vendor identity contract](https://github.com/vercel/ai/pull/19754)). The host keeps its own discovery catalog.
  - Drop orphaned reasoning, aborted-step items and foreign-provider executed parts from requests without rewriting canonical history.
  - Provider history rules and the context limit are plain functions over the AI SDK V4 prompt in `transformParams`. The AI SDK has neither primitive, and no Mastra processor or V2 prompt is involved.
  - Anthropic routes (its own API and OpenRouter's `anthropic/*`) get valid tool-call IDs and only their own thinking, judged by the serving provider's options key (`anthropic`, or `openrouter` for OpenRouter's `reasoning_details`). Signed thinking another SDK provider stamped is dropped for every target.
  - Over the input limit, the request keeps every system message and the most recent conversation that fits, starting at a user turn so no tool call loses its result, measured exactly as it is accounted; a request that fits is measured once. When even the latest turn can't fit, the run refuses with `provider.context-overflow`.
  - Tokenizer-measured models (the direct OpenAI rows) are counted on one worker thread that holds the o200k encoder ([`token-counter.ts`](../../packages/agent/src/token-counter.ts)), never on the host's main thread. The host starts it when the composer's memory read or a run's admission names such a model. A worker that cannot load or exits reads as `counter-initialization-failed`; there is no main-thread fallback.
- OpenAI with an API key uses stored responses. Expired stored items are typed, non-retryable failures; replaying without them needs the user's decision.

## Credentials and privacy

Decision: [ADR-0014](../adr/0014-provider-credentials-and-openai-storage.md). Owner: [provider auth](../../packages/host-capabilities/src/provider-auth.ts).

- Pass typed credentials or authenticated fetch capabilities directly to their consumer.
  - Model-facing context, run snapshots and public status/log events never carry secrets.
  - Dedicated credential operations keep their authenticated secret-store boundary.
- An admitted auth input is authoritative; it never falls back to another runtime or environment identity.
- Missing credentials and unreadable secrets are different failures.
- Bedrock precedence: environment bearer, stored bearer, environment chain, stored chain. Resolve AWS chains only through the injected host capability.
- Sign in with ChatGPT ([ADR-0038](../adr/0038-sign-in-with-chatgpt.md)) is the `chatgpt` provider, apart from `openai` and its API key.
  - The host's [sign-in](../../packages/host-capabilities/src/provider-auth/chatgpt-sign-in.ts) is the only reader and writer of its record. A client sees a state and an email; no secrets channel returns the tokens.
  - A request gets its token from the host's closure, which renews it first when due. The base URL is pinned to `https://api.openai.com/v1`.
  - Its requests set `store: false` and carry no output limit, temperature or top-p. OpenAI's plan refusals are never retried.
  - No other provider authenticates through a subscription sign-in.
- Environment diagnostics hold names, paths and loader messages, never secret values or fingerprints.

## MCP configuration and lifetime

Owner: [MCP host services](../../packages/host-capabilities/src/mcp/).

- Transport is explicit: stdio, Streamable HTTP or legacy SSE.
  - A failed connection or HTTP auth error never selects another transport or proves legacy negotiation.
  - Read the actual negotiated capabilities, not a package's latest-version constant.
  - Registered extensions advertise only complete, validated implementations for the connection's negotiated revision.
- Configured-server authority and connection generations fence admitted tools, resources, task handles, app frames and human input.
  - Reconfiguration or close retires their capabilities; restart verifies the captured non-secret authority before rebuilding bindings.
  - A credential record ID doesn't prove an unchanged private principal. Missing authority refuses visibly.

## Tools and saved choices

- Keep authored validation, executor identity, permission identity and raw output separate from bounded model projections.
- Strict provider schemas use representable shapes without cross-field refinements; they accept declared cross-action fields and reject unknown keys.
- Tool omissions and projection truncation stay explicit.
- [MCP settings authority](../../packages/host-capabilities/src/mcp/settings-authority.ts) owns config and preferences.
  - Merge writes keep undiscovered tool IDs, refuse unreadable preferences before changing the live registry, and use the shared file lock.
  - Discovery absence is not retirement; an explicit reset deliberately replaces saved choices.
- Protocol verification: [MCP conformance](mcp-conformance.md).
