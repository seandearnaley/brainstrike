# ADR-0038: Sign in with ChatGPT is a provider of its own

- **Status:** Accepted (Sean, 2026-11-12: "add the ability to signin with chatgpt/openai")
- **Date:** 2026-11-12
- **Amends:** [ADR-0014](0014-provider-credentials-and-openai-storage.md), which records the
  removal of the earlier ChatGPT subscription sign-in on 2026-10-22.

## Context

The sign-in removed in October reused the Codex CLI's OAuth client and sent requests to
ChatGPT's private `backend-api`. OpenAI has since published
[Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) for
open-source and locally run apps: the user registers the app as their own OAuth client, and
its tokens pay for requests to the public Responses API from their ChatGPT plan. Brainstrike
is MIT-licensed and runs locally, so it qualifies without a client secret or partner key.

OpenAI's development kit for this flow is licensed for noncommercial use only and is not
published to npm, so none of its code is used.

## Decision

1. **A provider, `chatgpt`, beside `openai`.** The two routes differ in who pays, which
   models answer, and what a request may carry, and a person may hold both an API key and a
   sign-in. A catalog provider row states those differences once; the model a thread selects
   is also the choice of who pays. Its rows carry no `pricing` and no `nativeToolSearch`.
   Their ids are `chatgpt/`-prefixed, because a model id names one catalog row across every
   provider and the `openai` rows hold the bare ids; the prefix is dropped where the request
   is built. Their names end in "(ChatGPT)", as OpenRouter's and Bedrock's rows name their
   route: the composer shows a selected model by its name alone.
2. **The host owns the sign-in.** The flow, the tokens, their renewal and their revocation
   live in [`chatgpt-sign-in.ts`](../../packages/host-capabilities/src/provider-auth/chatgpt-sign-in.ts),
   in the agent host. Main forwards Settings' calls and opens the browser; the renderer
   receives a state and an email. No secrets channel returns this credential.
3. **`openid-client` is the protocol.** Discovery, PKCE, the code exchange, ID-token
   validation, refresh and revocation are the certified library's. The loopback listener is
   the one MCP sign-in already uses. The code written here is what OpenAI adds: the
   `dynamic_agent_client` registration, `ext_agent_host_id`, the plan scope
   (`chatgpt.tokens.use.direct`) and the `https://api.openai.com/v1` resource.
4. **One record, kept through sign-out.** The credential store's `chatgpt` account holds
   `{ hostId, clientId, subject, email, session }`. The host ID is written before the first
   attempt and the issued client ID before the code is spent, as OpenAI requires. Sign-out
   revokes the refresh token and drops `session`; the rest stays so the next sign-in reuses
   the registered client. Only a record with a session counts as a configured credential.
   The sign-in is the record's only writer: the key paths (`auth/login`,
   `auth/credential/*`) refuse the account and the type.
5. **One account at a time.** A sign-in that returns a different account than the registered
   one is refused. "Use a different account" ends the session and registers again, because
   OpenAI binds a client to one user and one workspace.
6. **A token per request.** The auth input is `{ kind: 'access_token', accessToken }`, a host
   closure the AI SDK calls before each request (`apiKey` accepts a function). It renews a
   token within five minutes of expiry, once for all concurrent callers. A refresh token
   OpenAI no longer accepts ends the session; a network failure does not.
7. **Requests follow the preview limits.** The model is built with the base URL pinned to
   `https://api.openai.com/v1`, so `OPENAI_BASE_URL` cannot redirect a person's token. Every
   call sets `store: false` and sends system text as developer messages, and drops
   `maxOutputTokens`, `temperature` and `topP`
   ([`chatgpt-plan-call.ts`](../../packages/agent/src/providers/chatgpt-plan-call.ts)).
8. **A plan refusal is never retried.** OpenAI's `subscription_sharing_*` and `chatpass_v2_*`
   errors become refusals with their remedy; a usage limit points at
   `https://chatgpt.com/settings/usage`.
9. **Cancel ends a sign-in wherever it is.** Cancel in Settings, or the requesting client being
   retired (a quit, a reset), stops the callback wait and any request to OpenAI in flight, and
   nothing after it is kept: a redirect that already arrived signs nobody in.
10. **Desktop only.** A host is lent a browser opener or it has none. The CLI host has none, so
   sign-in refuses there with "Sign in from the Brainstrike desktop app."

## Consequences

- The model list is the catalog's, not the account's. OpenAI lists models per account at
  `GET /v1/models`; Test connection reads that endpoint to prove the sign-in works, and a
  model the account lacks fails at request time with OpenAI's own error.
- `contextWindow` on these rows is the plan's default input window, not the model's maximum.
- Native web search and native tool search stay off for this provider. The host's own tool
  discovery and Tavily search apply, as for any provider without them.
- Memory models are not offered from this provider: its token answers the thread's model
  requests only.
- A factory reset deletes the record with the credential store, and so registers a new host
  ID and client afterwards. "Clear Database" keeps it.
- Anthropic subscription sign-in stays rejected: Anthropic publishes no equivalent program.
