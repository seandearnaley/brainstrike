# Capable workers and context transfer — evidence

Supports `docs/agents/assistant-subagents.md` § "Capable workers and context transfer".

Read before changing worker discovery, the delegated system-context snapshot, `messageFilter` selection, or read-only specialist memory.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 86–171 at commit 7c3eb8f38.

---

Workers require hosted catalog discovery; pins to the embedded `local` provider
are visibly omitted before model resolution, preserving the root local runtime's
no-skills boundary. Ollama and LM Studio use their existing hosted adapters.
The worker input budget derives from its resolved context window with the shared
output reservation and safety margin. Catalog names remain deferred rather than
being enumerated in worker system instructions. Whole-result delegation hints
use each registered child's actual permission-gated artifact-reader capability,
including wildcard workers; a denied reader never produces a hint.

The root stores only its host-projected system text in native RequestContext
snapshot data before inference. Both approval and question resume restore that
original data, so newly started children inherit it too; callbacks, RuntimeData,
tool results and execution capabilities are never serialized. Non-text metadata
is excluded from system authority exactly as in the root message converter.
Legacy snapshots without this context reject new children visibly. Storage-backed
resumes install the processor even when the caller omits the optional memory
address. The native snapshot also retains the original root thread id, so child
discovery can restore loaded tools while still excluding parent history. The original root system text occupies native snapshot storage even
when no child starts; only actual child admission applies the child byte budget.

Trusted context size is validated only when a child starts. Invalid or
oversized trusted context rejects that delegation before child inference; native
Mastra returns the tool error to the supervisor so it can respond. Disabled
delegation does not validate unused child context. Permission `allow`/YOLO permits
worker effects without a new prompt; `ask` requires the exact durable child decision.

Workers reuse permission filtering, output-artifact settlement, model projections,
canonical catalog search/loading, skill injection, provider history compatibility,
token limiting and error processors. Each child discovery catalog contains only
its post-permission native/MCP subset; search/load cannot widen that catalog.
Approval resume recalls discovery results from the actual native child thread and
resource via public `parseMemoryRequestContext`, then uses Mastra's context-store
parser before the paused tool executes. Parent history is never borrowed. Skill
metadata injection requires the corresponding permitted skill controls.
Explorer/Analyst keep their curated tool surface and provenance/reporting role.
Read-only specialists use native Memory with the same storage, retrieval options
and embedding configuration, but working memory disabled. Sharing the root
Memory instance also injected `updateWorkingMemory` and its mandatory per-response
system instruction, bypassing the specialist's curated tools; the BST-1771 Grok
capture spent its steps updating that scratchpad instead of inspecting files.
Worker-mode children retain their configured working memory. This does not turn
off child transcript persistence or change native thread ownership. Do not set
`defaultOptions.memory` merely to override this option: Mastra then treats the
child as owning its memory address and omits native child thread/resource injection.
Paired native tests: `delegated-system-context.integration.spec.ts` checks root
memory remains enabled while a read-only child reads evidence and reports without
memory-write tools/instructions; `worker-delegation.integration.spec.ts` retains
working memory and verifies delegated task content on initial and resumed workers.

Model/key pins retain existing fail-closed resolution. Local renderer inference
and surface capability rules are unchanged; no HTTP/runtime owner is added.

The initial `streamMastraAgent` entry captures host-supplied system messages,
not the generated supervisor prompt. `delegated-system-context.ts` adds those
text messages to the child's native MessageList under an owned tag before
suspension. Native snapshots retain the original workspace context across a
fresh approval runtime; resume does not reread changed AGENTS files. System
context over 64 KiB fails closed. Model-authored `params.instructions` is cleared
from the instruction override and appended to the delegated user task instead.
`messageFilter` selects at most 16 ordinary messages under a 64 KiB UTF-8
serialization budget. Read-only specialists receive parent conversation messages
as explicitly labeled reference text, preserving the source role/content inside
that reference, rather than inheriting the parent's assistant actions as their
own conversation. Native image/file parts remain structured model inputs; each
rewritten reference has an invocation-scoped identity without parent persistence
ownership. References are constructed lazily during selection and their complete
serialized size, including the label, counts toward the unchanged budget.
The native delegated task follows those references. This
boundary also applies on approval resume: the BST-1771 Grok replay otherwise
mistook parent coordination for its own work and waited for other specialists
instead of returning its briefing. Workers retain original message objects and
roles for their execution context. Both paths retain chronology;
trusted system entries, if supplied by the framework, are retained or rejected
when oversized. Pruning is logged. Hook failures propagate. Parent completion
uses the compact native child result for Worker, Explorer and Analyst, matching
Mastra 1.64's default. Raw nested tool results remain available to stream
projection and durable child persistence; this only controls the parent model prompt.

Paired evidence: persona/parser and child-factory specs; native
`worker-delegation.integration.spec.ts` inspects initial and resumed model roles,
exactly-once guarded hooks/effect, denial and parent result; native
`worker-discovery.integration.spec.ts` uses a real HTTP MCP server to prove
eligible-only loading and fresh-runtime approval execution; actual Electron
`delegated-worker-write.desktop.test.ts` reloads the pending decision and checks
a disposable file, parent continuation and history navigation without execution.
These prove the worker layer, not recursion/background/worktree coordination.
