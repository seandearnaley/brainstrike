# Agent package

Follow root instructions. This package supplies shared runtime contracts and
adapters; the host owns run execution, permissions and durable state (ADR-0012).

- Native tool definitions have one catalog in `@brainstrike/assistant-contract`.
  Reuse its schemas, metadata and derived registries. Desktop executors stay in
  the desktop host; do not introduce a parallel package-local implementation.
- Run, thread and workspace authority comes from validated host context, never
  model-provided arguments. Keep callbacks and process-local resources out of
  serialized data.
- Use the existing credential resolver and explicit MCP transport. Preserve
  protocol results until the owning persistence/output boundary handles them;
  do not infer transports or silently downgrade a failed capability.
- Browser-safe exports must not pull in Node-only runtime dependencies. Keep
  execution behind the existing CodeExecutor and permission seams.

Consult `docs/agents/assistant-providers.md`, `assistant-subagents.md`,
`code-execution.md` or `mastra-boundary.md` for the relevant contract. Commands and
export shapes come from package configuration.
