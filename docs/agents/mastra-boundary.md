# Mastra boundary

Mastra is a set of narrow `@mastra/core` utilities the host calls. It owns no
product state, no memory and no history.
Decisions: [ADR-0012](../adr/0012-ai-sdk-loop-mastra-memory-library.md) (amended),
[ADR-0023](../adr/0023-host-owns-its-tool-representation.md),
[ADR-0039](../adr/0039-host-is-the-only-compactor.md).
Implementation: `packages/agent` and `packages/agent-host`.

## Ownership

- The host owns one AI SDK loop per root or child run. Mastra owns no transcript,
  permission system, workspace, server, run coordinator or memory.
  - Do not resurrect the removed Mastra agent loop or Mastra memory under a new name.
  - No production code constructs a Mastra `Agent` or `Mastra`, or imports
    `@mastra/core/stream`. Some specs still build an `Agent` as a harness for the
    tool-shape adapters.
- A thread's context is the host's: Core assembles it from the committed log and
  the host's compaction is the only thing that replaces history (ADR-0039).
- `@mastra/core` is a direct dependency of `packages/agent`, `packages/agent-host`,
  `packages/test-utils` and the desktop app, used for:
  - hosted tool discovery (`ToolSearchProcessor`), skills (`@mastra/core/skills`,
    `@mastra/core/workspace`)
  - OpenRouter model routing (`ModelRouterLanguageModel`); provider-request
    shaping uses no Mastra processor
  - the committed transcript in Mastra's stored form (`MessageList`,
    `MastraDBMessage`), which tool discovery and the provider request's
    provenance read (`packages/agent-host/src/committed-transcript.ts`)
  - tool and schema shapes at those seams (`@mastra/core/tools`, `@mastra/core/schema`)
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
  - `@mastra/core` is Node-only and externalized from browser bundles; importing a
    subpath does not make its shared chunks browser-safe.
  - No Harness, mastracode, libsql, server/deployer adapters or browser runtime
    without an owner decision.

## Vendor patches

Pins live in `pnpm-workspace.yaml`. No Mastra package is patched.

- A patch rewrites vendor `dist` regardless of callers, so a hunk losing its
  consumer never fails install. Argue reachability from what the hunk changes, not
  from who constructs its class; retire unreachable hunks on version bumps.
- A new patch needs a proven defect on a path the host reaches, carries its
  upstream reference and removal condition at the code it touches, and a version
  bump needs the affected adapter proof.

## Integrity

- Resolve credentials with Brainstrike's credential owner before materializing a
  model; a routing string must not trigger vendor env or gateway fallback. Fail
  visibly when a required model capability is missing.
- Serialized RequestContext never holds callbacks, AbortSignals, secrets or
  process-local resources. Client fields are validated and re-derived at the host;
  a snapshot cannot supply its own permission or workspace authority.
- The committed host log and its projections are the UI/persistence contract, not
  vendor UI streams or workflows.
- Do not drop structured protocol/tool content before its output/persistence owner.
  Vendor observability/evals never become a data sink or product store.
