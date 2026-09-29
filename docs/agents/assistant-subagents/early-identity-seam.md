# Early identity seam and native contract proof — evidence

Supports `docs/agents/assistant-subagents.md` § "Maintaining the native contract proof".
Supports `docs/agents/assistant-subagents.md` § "Early identity seam".

Why the child scope is bound during input preparation rather than in an output processor or `onChunk`.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 716–762 at commit 7c3eb8f38.

---

Re-run `mastra-subagent-contract.integration.spec.ts` and update the capability
matrix when upgrading `@mastra/core` or `@mastra/memory`. The agent package uses
`*.integration.spec.ts` (its explicit integration include and unit exclude),
so this real-PGlite suite belongs only to the uncached integration task.

The fail-closed strategy covers every delegation hook, including diagnostic
logging. A broken diagnostic sink is surfaced, not silently swallowed. The
start hook validates and clamps typed scalar limits; it does not log or await
after acquiring its counters. Completion releases its slot before reporting
usage or diagnostics.

### Early identity seam (BST-1718, native proof only)

Core 1.64.0 exposes the actual child scope through the public
`parseMemoryRequestContext` helper from `@mastra/core/memory` during the child's
input processor. The native suite verifies two concurrent calls to the same
persona, with and without explicitly configured child Memory. The processor
awaits a real database query before recording each scope, and every forwarded
child event, including the initial `start`, observes its own recorded identity.
The scope agrees with `onDelegationComplete`'s actual child thread/resource;
the nested stream's run id agrees with the child output processor's run id.

Use `createDelegatedConversationBinding` to join the child input scope to the
parent's tool-call id. It keys a host-owned WeakMap by the child RequestContext
object supplied to `onDelegationStart`; no product entries are added to that map.
Neither persona name, completion order nor parsing generated ids establishes
this relationship. The child's native resource can differ from the root's
resource, so it is not the user's ownership authority.

An output processor alone is too late for this contract: the first native
`start` bypasses it (the original ordering assertion failed on exactly this
event). `onChunk` also runs after enqueue in the installed implementation.
Bind the thread scope during input preparation and await the host's durable
invocation/run binding at its stream-publication boundary. The paired failure
case proves that an input binding error is visible and prevents child model
and tool execution.

The initial-call seam is paired with durable graph storage and host access
checks below. A durable-snapshot resume may skip input preparation; production
resume authorization uses the persisted invocation and checks the exact root,
turn, persona and native run before publication. See the current [processor lifecycle reference](https://mastra.ai/reference/processors/processor-interface).

The first storage layer adds the host-only delegated conversation graph in
`@brainstrike/db`, with exact native scope checks across the full ancestor chain,
immutable child configuration/workspace binding, and explicit legacy absence.
Desktop production delegation now uses this graph together with invocation/run
identity, branch cleanup, publication/resume checks and usage reconciliation. See `assistant-persistence.md` and `database.md`.


### 2026-09-26: unpatched 1.71 executing-input boundary

`beforeToolCall.context.messages` is the pre-model prompt on core 1.71.0;
`onDelegationStart.messages` also omits parent tool parts. Neither is an
executing-call registry. Native foreground integration failed before child
admission because Brainstrike scanned that history for the current call.
Capture the public hook's `input` with its native context identities instead,
clone it immediately, and check the persona and prompt again at admission.
Model-authored thread/call fields never substitute for native context identity.

Guards: `packages/agent/src/mastra/__tests__/delegated-observed-input.spec.ts`
and `packages/agent/src/__tests__/delegated-conversation-stream.integration.spec.ts`.
The former rejects absent native identity, duplicate capture and mismatched
persona/prompt, and checks input snapshotting. The latter exercises the real
native stream, including concurrent calls to the same persona.

This correction does not establish background output ownership, selected Stop
cleanup, or desktop approval recovery. The upgrade remains a candidate until
those assembled paths pass; native capability tests do not establish desktop
or process-restart correctness.
