# BST-616 — confined read-only programmatic orchestration spike

Date: 2026-07-21  
Decision: **do not add a production programmatic-orchestration mode yet.**

## Executive result

Programmatic orchestration has a real efficiency ceiling, but neither evaluated
route cleared Brainstrike's quality and integration gates:

- OpenAI GPT-5.6 Luna reduced provider input tokens by 71–94% and estimated
  cost by 56–89% on three synthetic fan-out workloads. It was strictly correct
  on only one of three first runs. Direct calling was correct on all three.
- The installed Mastra 1.51.0 / AI SDK OpenAI 4.0.8 path cannot express the
  hosted `programmatic_tool_calling` tool, `allowed_callers`, function
  `output_schema`, nested `caller`, or `program` / `program_output` continuation
  items. A bespoke transport would bypass the provider-history, persistence,
  suspension, telemetry, and processor contracts this work is meant to improve.
- OpenCode's confined interpreter correctly reduced the same fixed programs in
  6–21 ms and kept 98–99% of raw intermediate characters out of its final
  result. It also rejected an unexposed write as `UnknownTool` and stopped a
  fourth call at the configured limit. Those runs used hand-authored programs;
  they do not establish non-inferior model-authored-program quality.

The right architecture is still an explicit orchestration stage, not a more
powerful general shell. Revisit it behind an upstream-supported Mastra/AI SDK
seam and a representative model-written-program eval. Do not bolt a second
Responses loop beside Mastra.

## Current contracts

### OpenAI

The current Programmatic Tool Calling guide defines a fresh isolated V8 runtime
with no Node.js, packages, network, general filesystem, subprocesses, console,
or persistent JavaScript state. The application supplies all authority through
eligible tools. Tools opt in with `allowed_callers`; predictable structured
results should define `output_schema`. Client-owned calls still execute in the
application, and the continuation must preserve every `program`, reasoning,
function-call, function-call-output, and `program_output` item, including the
nested `caller` relation.

OpenAI recommends this route for predictable filtering, joining, ranking,
deduplication, aggregation, and validation. It recommends direct calls when one
call is sufficient, each result needs fresh semantic judgment, the operation is
approval-sensitive, or citations/native artifacts must be preserved. It also
requires per-call argument and permission checks and says to establish a direct
baseline before accepting an efficiency win.

GPT-5.6 is documented as supporting the capability. The live spike used
`gpt-5.6-luna`, `store: false`, low reasoning, explicit route instructions,
structured function inputs/outputs, zero retries, and the documented stateless
continuation protocol.

### Installed Mastra / AI SDK seam

Source inspection and a red/green dependency canary prove the current adapter
gap:

- `createOpenAI(...).tools` has no Programmatic Tool Calling provider tool.
- `OpenAIResponsesTool` has no `programmatic_tool_calling` member.
- function tools serialize `strict`, `defer_loading`, parameters, name, and
  description, but not `allowed_callers` or `output_schema`.
- response input/output types have no `program`, `program_output`, or nested
  `caller` fields.

The spike deliberately does not cast around these types or add a second raw
transport. The dependency canary will fail when the missing surface appears so
this decision is revisited rather than drifting stale.

### OpenCode confined interpreter

OpenCode local reference HEAD
`888c4cb50476aaecaad48e6a448759da3040ed2e` exposes only the post-permission
catalog to Code Mode. Every nested call goes back through host permission,
lifecycle hooks, the official MCP client, cancellation, timeout, and progress
paths. The interpreter supplies no ambient filesystem, process, network, or
module access.

The library provides structured success/failure diagnostics and host-configured
timeout, tool-call, and output budgets. It intentionally has no default limits,
so a Brainstrike host would have to set every bound. Effect schemas validate
inputs and outputs; JSON Schema is render-only, so adapter/service validation
cannot be delegated to the interpreter.

## Method

The three workloads used fixed synthetic data rather than user files:

1. multi-file fact extraction from three large content results;
2. repeated inspection of three symbols with overlapping reference sets;
3. retrieval and deterministic joining of three structured sources.

The direct and hosted-programmatic routes received the same tool contracts,
data, target facts, and evidence requirements. The hosted route alone received
`allowed_callers: ["programmatic"]` and the hosted orchestration tool. All
client tools were pure, allowlisted reads. The renderer obtained the stored key
through Brainstrike's existing secure preload bridge and performed the API
requests under an attached CDT session; no key or real workspace content was
printed or persisted by the harness.

The OpenCode run copied the exact Code Mode source to a disposable directory and
installed its pinned `effect@4.0.0-beta.83` and `acorn@8.15.0` dependencies. The
repository's Effect patch changes only SSE schema naming and does not touch the
interpreter path. The programs were hand-authored to isolate confinement and
reduction overhead from model quality.

## Live GPT-5.6 Luna measurements

Pricing uses OpenAI's listed 2026-07-21 Luna rate of $1/M input and $6/M output;
it is comparative, not an invoice.

| Workload | Route | Strict result | Requests / calls | Input / total tokens | Latency | Estimated cost |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Multi-file extraction | direct | pass | 4 / 3 | 9,815 / 10,046 | 5.17 s | $0.011201 |
| Multi-file extraction | programmatic | **fail**: structured `evidence_missing` despite all three calls | 2 / 3 | 1,953 / 2,458 | 7.75 s | $0.004983 |
| Repeated symbols | direct | pass | 6 / 5 | 29,243 / 29,767 | 8.64 s | $0.032387 |
| Repeated symbols | programmatic | pass | 2 / 3 | 1,883 / 2,176 | 12.19 s | $0.003641 |
| Multi-source join | direct | pass | 4 / 3 | 13,108 / 13,449 | 16.27 s | $0.015154 |
| Multi-source join | programmatic | **fail**: omitted two required versions | 2 / 3 | 3,814 / 4,125 | 5.99 s | $0.005680 |

Programmatic input-token reductions were 80.1%, 93.6%, and 70.9%; estimated
cost reductions were 55.5%, 88.8%, and 62.5%. Latency was 50.1% and 41.2%
slower on the first two workloads and 63.2% faster on the third.

One diagnostic rerun of the two failures did not establish stability. The
multi-file workload again returned `evidence_missing`. The multi-source run
included every required value but still returned `ok: false` and
`evidence_missing`. This is useful evidence of the route's potential, but it is
not non-inferior correctness.

## OpenCode runtime measurements

| Fixed program | Result | Tool calls | Raw intermediate chars | Confined result chars | Runtime |
| --- | --- | ---: | ---: | ---: | ---: |
| Multi-file extraction | pass | 3 | 29,286 | 257 | 20.692 ms |
| Repeated symbols | pass | 3 | 21,645 | 263 | 9.912 ms |
| Multi-source join | pass | 3 | 20,670 | 476 | 6.077 ms |

The final boundary was 99.1%, 98.8%, and 97.7% smaller than the raw
intermediate JSON. An unexposed write produced `UnknownTool`; a fourth read with
`maxToolCalls: 3` produced `ToolCallLimitExceeded`. These measurements validate
the interpreter primitive and host-policy model, not model-authored code.

## Exact future eligibility boundary

If this is revisited, the program-visible set must be the intersection of the
post-capability, user-enabled, permission-admitted catalog and this exact
read-only allowlist:

- `brainstrike.readWorkspaceFile`
- `brainstrike.readWorkspaceDirectory`
- `brainstrike.globWorkspace`
- `brainstrike.grepSearch`
- `brainstrike.findWorkspaceSymbol`

Every nested call must re-run input validation and the existing host permission
gate. The orchestration tool itself must set a finite timeout, maximum of eight
concurrent calls, maximum call count, maximum output bytes, cancellation, and a
structured provenance record for every admitted call.

Keep semantic/adaptive retrieval (`hybridSearch`, embedding queries), web search
and extraction, artifact continuation, MCP discovery, LSP diagnostics, command
sessions, shell execution, approvals, writes, plan/task state, external
messages, and every unknown tool direct. The same applies to any read whose
output schema or evidence contract cannot be validated.

## Decision and next gate

Do not create an implementation ticket from this spike: the API showed material
efficiency, but strict quality was inferior and the installed production adapter
cannot preserve the required lifecycle state. The local interpreter showed a
strong primitive, but only with hand-authored programs.

Reopen the decision only when all of these are true:

1. Mastra and the installed AI SDK expose the complete Programmatic Tool Calling
   request/response and continuation contract without casts.
2. A captured-request suite proves no `program`, reasoning, nested caller,
   function output, or `program_output` item is lost across live, approval,
   restart, and stateless continuation paths.
3. Model-authored programs pass the three-workload corpus and adversarial limit,
   malformed-output, permission-denial, cancellation, and partial-failure cases
   with non-inferior correctness and evidence coverage.
4. The accepted route is explicit. There is no silent switch to direct calls and
   no second general agent runtime.

No production route, tool definition, permission, persistence, processor, or
runtime behavior changed in this spike.

## Primary sources

- [OpenAI Programmatic Tool Calling guide](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling)
- [OpenAI GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI GPT-5.6 Luna model and pricing](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [Mastra processor lifecycle workshop](https://mastra.ai/workshops/implement-processors-in-mastra)
- [OpenCode Code Mode host integration at the inspected commit](https://github.com/anomalyco/opencode/blob/888c4cb50476aaecaad48e6a448759da3040ed2e/packages/opencode/src/tool/code-mode.ts)
- [OpenCode confined interpreter contract at the inspected commit](https://github.com/anomalyco/opencode/blob/888c4cb50476aaecaad48e6a448759da3040ed2e/packages/codemode/README.md)

Adapter capability claims were additionally checked against the exact installed
Mastra 1.51.0 and `@ai-sdk/openai` 4.0.8 declarations in this worktree; the
dependency canary pins that local evidence in CI.
