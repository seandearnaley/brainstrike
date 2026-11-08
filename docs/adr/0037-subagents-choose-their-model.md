# ADR-0037: A subagent runs on the model its delegation names

- **Status:** Accepted (Sean, 2026-11-06: "work through this and all the problems" of the
  cross-model delegation brief, on the `integration/cross-model-delegation` branch)
- **Date:** 2026-11-06
- **Amends:** [ADR-0028](0028-cross-host-subagents.md) "Admission by reference: same
  `LanguageModel`", and the [subagent contract](../agents/assistant-subagents.md) rule that
  children inherit the admitted parent model.

## Context

A child reused its parent's model instance, provider port, tool schemas, context limit and
memory owner by reference. A persona could declare `model: provider::modelId`, Settings
showed the pin, and every delegation to it was then refused (`persona.model-pinned`).

A model's request rules, tool schema dialect, context limit, credentials and reasoning
options are all admitted per model. Swapping the model ID alone would price, trim and
prompt the child for the wrong model.

## Decision

1. **The child's model.** A persona's pin wins. Otherwise the delegation may name a
   `model` from the models the person allowed (Settings → Subagents), and an `effort`.
   Otherwise the child runs on its parent's admitted model, by reference, as before.
2. **One effort scale:** `none · minimal · low · medium · high · xhigh · max`. Each model
   accepts the part its catalog reasoning controls offer (`childModelEfforts`). An effort it
   does not offer refuses the delegation with the efforts it does; nothing clamps.
3. **Admitted like any run.** Core admits the child's model through
   `acquireHostRunAdmission`, under the root thread's intent, policy and folders. The
   platform supplies one function, `childConfiguration`, which rewrites the parent's run
   configuration for the child. The child's model, provider port, tool schemas, context
   limit and memory owner are then that model's own, and its descendants inherit them.
4. **Generation options come from the delegation.** The child's request options are the
   shared builders' (`@brainstrike/assistant-contract/generation-options`) for its model
   and effort. The person's composer settings for that provider do not apply; children have
   their own limits under Settings → Subagents.
5. **Committed as the child's.** The child's `run.started` and thread selection name its own
   model and configuration. The ledger then prices it, a person's follow-up runs on it, and
   the child toolbar and generation details show it.
6. **Refused, never substituted.** A model the host cannot admit (not allowed, not enabled,
   no credential, a run with no desktop intent, a host without `childConfiguration`) returns
   `[Delegation Rejected] … cannot run on <model>: <reason>` to the parent's model, and no
   child thread starts.
7. **The tool says what it offers.** A persona's delegation tool takes `model` and `effort`
   only when the person allowed models and the persona pins none. The `model` enum is the
   allowlist. The allowed models join the tool identity only when present, so a person who
   allows none keeps the identities of before.

## Consequences

- Each cross-model child holds its own admission (MCP borrow, memory owner, native
  runtime) until it settles. A same-model child still borrows its parent's.
- The CLI's workspace runs carry no desktop intent, so a pin or a named model is refused
  there until the CLI owns a `childConfiguration`.
- `admitted-child-configuration.ts`, the Mastra-era persona restore schema with no
  production caller, is removed.
