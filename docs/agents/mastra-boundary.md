# Mastra boundary

Mastra is an embedded memory library behind a host adapter, plus a set of
narrow `@mastra/core` utilities. It owns no product state.
Decisions: [ADR-0012](../adr/0012-ai-sdk-loop-mastra-memory-library.md),
[ADR-0023](../adr/0023-host-owns-its-tool-representation.md).
Implementation: `packages/agent-host` (memory adapters, `HostMemory`) and `packages/agent`.

## Ownership

- The host owns one AI SDK loop per root or child run. Mastra owns no transcript,
  permission system, workspace, server or run coordinator.
  - Do not resurrect the removed Mastra agent loop or its vendor patch under a new name.
  - No production code constructs a Mastra `Agent` or `Mastra`, or imports
    `@mastra/core/stream`. Some specs still build an `Agent` as a harness for the
    tool-shape adapters.
  - The only production `Agent`s are the observer and reflector that
    `@mastra/memory`'s observational memory builds internally for `HostMemory`.
- `@mastra/core` is a direct dependency of `packages/agent`, `packages/agent-host`
  and `packages/test-utils`, used for:
  - hosted tool discovery (`ToolSearchProcessor`), skills
  - OpenRouter model routing (`ModelRouterLanguageModel`); provider-request
    shaping uses no Mastra processor
  - memory and background-task storage adapters, schema
  - Each use is its own decision; none makes Mastra an owner or licenses widening
    the surface.
- The host's tool representation is its own: `HostToolDefinition` at the producer,
  `HostTool` after authority binding, AI SDK `ToolSet` at the edge.
  - Never reintroduce a vendor tool type as the intermediate shape.
  - Producers get one host execution context with top-level identity and a
    structural writer; question/plan suspension and per-call network consent
    belong to HostCore.
  - MCP keeps its raw JSON Schema and Ajv validator. Missing validators refuse
    registration; reopened approvals validate their committed raw input before
    execution.
- Brainstrike owns HTTP entry/auth/origin checks, streaming, tool admission, native
  workspace tools and committed persistence.
  - Mastra-owned tables are never altered to store product state.
  - `@mastra/core` is Node-only and externalized from browser bundles; importing a
    subpath does not make its shared chunks browser-safe.
  - No Harness, mastracode, libsql, server/deployer adapters or browser runtime
    without an owner decision.

## Vendor patches

Pins and patches live in `pnpm-workspace.yaml` and `patches/`.

- A patch rewrites vendor `dist` regardless of callers, so a hunk losing its
  consumer never fails install. Argue reachability from what the hunk changes, not
  from who constructs its class; retire unreachable hunks on version bumps.
- `@mastra/core`: one change (ESM and CJS) in
  `AgentThreadStreamRuntime.prepareRunOptions` forwards the caller's abort reason,
  so Memory's observer/reflector streams see the host's Stop instead of a generic
  `AbortError`.
  - Owner: `packages/agent-host/__tests__/memory-public-lifecycle.test.ts`
    (owner-signal, narrower call signal and async-reflection turn signal cases).
- `@mastra/memory`: the M3 lifecycle patch, built on the vendor's `runOMCommit`
  commit queue (flag writes keep that queue).
  - Unpatched, every `memory-public-lifecycle` case fails (ESM and CJS).
  - Lifecycle owners: `memory-public-lifecycle`, `memory-adapter`,
    `memory-native-ownership`. Group details:
    [the M3 memory contract](../../packages/agent-host/src/adapters/memory-m3-contract.md).
- A narrow patch carries its upstream reference and removal condition at the
  code it touches. A version bump needs the affected adapter proof.

## Engine use and storage contracts

- Production engine use is only `HostMemory`'s `beginTurn`/`start`/`step`/`end`.
  - Thread deletion: `HostCore.deleteThread`, then the StateStore `purge-thread`
    memory request.
  - Factory reset and content clear run in desktop main, which imports no
    `@mastra` package.
- Outcome-reporting commits: `StateStoreMemoryStorage` forwards
  `commitActiveObservations` (vendor retries on `applied: false`) and
  `appendBufferedObservations` (vendor drops `persisted: false` chunks) to the
  native calculator, returning the real outcome. Never fall back to the base
  class's assumed success. Both write existing observation rows.
- Observation vector `record_id` metadata must name a committed record in the
  indexer's plan for that group. The derived index keeps its own row identity, so
  recall hits carry no `record_id`; Mastra resolves the generation via its lineage
  lookup.

## Memory, context and adapter integrity

- Build memory through the host resource/thread scope and storage adapter.
- Resolve credentials with Brainstrike's credential owner before materializing a
  model; a routing string must not trigger vendor env or gateway fallback. Fail
  visibly when required model/storage capability is missing.
- Serialized RequestContext never holds callbacks, AbortSignals, secrets or
  process-local resources. Client fields are validated and re-derived at the host;
  a snapshot cannot supply its own permission or workspace authority.
- The committed host log and its projections are the UI/persistence contract, not
  vendor UI streams or workflows.
- Keep native memory/observation identities and canonical text. Derived search
  indexes them through the index owner: no alias row, second writer or shadow
  database.
- Cancellation and disposal keep physical resource ownership until their joins
  settle, including independent cleanup failures.
- Do not drop structured protocol/tool content before its output/persistence owner.
  Vendor observability/evals never become a data sink or product store.
