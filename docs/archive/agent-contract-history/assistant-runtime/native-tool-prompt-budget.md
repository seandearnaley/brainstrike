# Hosted native-tool definition and prompt budget — evidence

Supports `docs/agents/assistant-runtime.md` § "ASSISTANT RESILIENCE (CRITICAL)".
Read before changing native tool descriptions/schemas, the input-processor order, or the hosted prompt-budget regression. BST-1646, BST-1095.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 969-1025), extracted verbatim.

**Hosted native-tool definition and prompt budget (LIVE):**
The runtime does not maintain a parallel provider-tool catalog.
`@brainstrike/assistant-contract` supplies canonical ids and descriptions from
the per-tool `defineNativeTool` declarations (`native-tools/definitions/*.ts`,
BST-1646); `NATIVE_TOOL_INPUT_SCHEMAS` in `packages/agent/src/tools/schemas.ts`
is derived from those same declarations and supplies the exact Zod input object
for each desktop native id. The desktop registry
uses those objects directly, `validateToolInput` parses with the same map, and
Mastra performs the Standard Schema → provider JSON Schema conversion. The
browser-safe `NATIVE_TOOL_SCHEMAS` registry is lossy display metadata derived
from those same Zod objects (`toToolSchemaDisplay`, BST-1646) and MUST NOT
enter execution, validation, or provider registration.

The hosted surface is guarded at both sides of Mastra's conversion boundary.
The authored full-registry red baseline must fit within 7,900 `o200k_base`
tokens. The live actual Mastra/OpenRouter core surface and resolved instructions
must fit within 5,000 tokens, materially below the retired 11,500-token eager
boundary. Live hosted first requests add Mastra's `search_tools` and `load_tool` controls;
deferred post-gate definitions are appended on later steps.
The production-equivalent fixture enables a representative workspace skill so
both numbers include the three default skill tools, conditional skills
guidance, and first-turn `SkillsProcessor` metadata; a registry measured
without `workspaceSkills` is an undercount.
Mastra 1.51 currently expands optional fields for the routed `openai/*` model;
the authored guard is therefore not evidence for the provider payload. The
regression constructs the real desktop registry and real hosted runtime
(`apps/desktop/src/__tests__/assistant-server/native-tool-prompt-budget.test.ts`);
an isolated description, schema estimate, or hand-built provider payload is
not sufficient evidence.

The per-call input-processor order is SkillsProcessor → ToolSearchProcessor →
ProjectionSafeToolCallFilter → ToolProjectionRewriteProcessor → ProviderHistoryCompat →
OpenAIToolSearchHistoryCompat → OpenAIDuplicateItemCompat →
ProjectionAwareTokenLimiter. The OpenAI-only compatibility seams are absent for
every other provider; token limiting is always last. OpenAIDuplicateItemCompat
(BST-1095) canonicalizes duplicated OpenAI item references at the transient
boundary — Mastra's sealed-boundary re-key can double-persist one assistant
response under two message ids, and a prompt carrying both copies serializes
two input items per `rs_`/`fc_`/`call_` id, which OpenAI rejects with
"Duplicate item found". Canonicalization must not trade that 400 for another:
reasoning/text ids keep their newest occurrence; a tool call and its output
(tool-role for client tools, assistant-role for provider-executed tools like
native web search) are kept as the newest COMPLETE pair so no
`function_call_output` survives without a preceding call; reasoning left
trailing in an edited message is swept ("reasoning without its required
following item" is also a 400); emptied messages are removed. Within-message
repeats are untouched (multi-summary reasoning merges provider-side) and
durable history is never mutated. It runs after the other compat rewrites so
it sees the item references they produce. Initial streams, approval resumes, and suspending-tool resumes reuse the
same discovery and history-filter processor instances so same-process approval
executors remain available while persisted discovery results provide restart
reconstruction.

Default instructions should state cross-tool routing and non-negotiable
invariants once, while canonical descriptions/schemas carry per-tool mechanics.
See `docs/agents/workspace-context.md` for the instruction invariants that
cannot be compacted away.
