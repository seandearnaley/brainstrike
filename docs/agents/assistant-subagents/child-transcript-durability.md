# Child transcript durability, parity and hydration — evidence

Supports `docs/agents/assistant-subagents.md` § "Cancelled child transcript durability".
Supports `docs/agents/assistant-subagents.md` § "Child tool input transport parity".
Supports `docs/agents/assistant-subagents.md` § "Child lifecycle ordering on reload".
Supports `docs/agents/assistant-subagents.md` § "Renderer receiver and native transcript ownership".
Supports `docs/agents/assistant-subagents.md` § "Native child response boundaries across resume".

Cancellation snapshots, the late-save fault injection, tool-input transport, hydration ordering and the response-boundary processor.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 1090–1286 at commit 7c3eb8f38.

---

Native delegation uses `lastMessages: false`. On core 1.64 this also suppresses
the automatic MessageHistory output processor; the delegation's normal save
occurs after consuming the child stream. Root Stop can return before that save.
The desktop regression first lost all child assistant content, then exposed a
late native save overwriting an early cancellation snapshot.

The child processor captures the public `MessageList`, memory scope and current
native `messageId` at `processInputStep`. The existing root abort finalizer joins
these child turns. Each captures its unsaved native messages on the owning
attempt's abort signal, awaits Mastra's public `afterToolCall` hook around the
native delegation tool, then uses the same
abort snapshot policy and awaited `Memory.saveMessages` as the root. It retains
partial text, removes unfinished tool calls and appends the abort marker without
inventing a child message id. Normal completion/pause does not write an abort
snapshot. Per-invocation completion is correlated by native parent run/tool call
and the existing isolated RequestContext identity, never persona name. The
per-attempt tool hook uses the same owning signal and observed native tool-call
id. It runs after success, execution errors and suspension, including failures
before the child input processor attaches. `onDelegationComplete` alone is not
a sufficient join: core 1.64 skips it on suspension and when resolving child
instructions outside its execution try/catch. Real native tests pin both paths.
The hook releases the abort listener and removes normally settled invocations;
abort finalization releases the remaining entries even when a save fails.
A later attempt can reuse a settled native identity, while an overlapping
invocation with the same native identity fails explicitly.

This capability is constructed only when the runtime has an explicit root
memory scope and a memory instance. Supplying only the library memory instance
still permits ordinary delegation. The root tool hook is installed only for
legs with active delegation; a memory-backed run without personas does not gain
child persistence hooks. Missing native child identities remain errors once the
scoped capability is active.

A production-loop regression stalls the memory-backed child model, allows the
real watchdog to fire, and requires the child's actual provider signal to be
aborted before a successful parent continuation. The test does not resolve the
child stream or the completion promise itself. The common timeout callback and
attempt-consumer finalizer both abort the owning attempt before the child joins.

All three attempt legs require the owning abort signal at stream-option and
delegation configuration boundaries. Child saves are joined before replacing a
watchdog attempt and before runtime disposal; a successfully recovered parent
still uses its normal root transcript policy. Child output processors combine
with native channel/memory processors in core 1.64; configuring this processor
does not replace the memory defaults.

The real desktop test covers Stop during a tool with and without partial text,
equivalent history on the still-open and reconstructed engines, exact lifecycle
event retention and absence of the unfinished tool call. It does not claim a
packaged process restart or cancellation during snapshot-resumed tool execution;
those remain in the nested resume and assembled E2E acceptance.

The delayed-consumer case waits for the tool to enter execution, then aborts the
owner. The authoritative root signal now prevents the old automatic native late
save. To retain the adversarial persistence proof, the test injects a late result
through the real `Memory.saveMessages` API using the observed native message id,
and reads that exact row back before resuming terminal consumption. The frozen
snapshot must replace that row and retain the visible partial text and cancelled
events after engine reconstruction. This is fault injection at the native writer
boundary, not a claim that a cancelled native run normally produces a late save.

Historically this case failed when snapshot capture and normal-finish
classification relied on the child's propagated signal, which can lag the owner.
The owner signal supplied by `buildStreamOptions` still governs both decisions;
the child cannot turn an already-cancelled owner turn into a normal finish.
`runTurnAttempts` joins child persistence in its generator finalizer after consumption;
no sleeps, retries or timeout changes establish the verifier's ordering.

### Child tool input transport parity (BST-1719)

A native multi-step child retains its observed message id in the saved Mastra
assistant row. The desktop production-loop test
`delegated-stream-parity.integration.test.ts` compares text, provider reasoning,
tool name/id/input/result and final text after the normal transport decoder and
a reconstructed native memory engine. This is content parity for the tested
normal turn, not a claim of complete receiver or resumed-message parity.

The shared encoder must transmit complete tool input through `c` argument
deltas before the `9` completion frame whenever `b` already started the call.
The catalog-pinned assistant-stream 0.3.41 decoder ignores `9.args` for an existing call;
`b` immediately followed by `9` therefore displayed `{}` even though native
storage retained the real input. The common completion helper emits complete
input when no argument deltas have flowed, or the missing suffix of a compatible
partial prefix, then closes the input. Empty containers and native tool-error
args take the same path. An incompatible authoritative input closes once and
fails the session visibly with preceding text retained; it is never concatenated
as a second JSON object or retried by terminal error handling.
This also covers root calls, late complete input and approval notices without
duplicating streamed JSON or changing native persistence.

### Child lifecycle ordering on reload (BST-1719)

Oversized child outputs pass through the parent's central artifact-settlement
policy after child permission selection and before projection at the child's own
model budget. Migration 129 distinguishes native execution threads within the
root-owned artifact scope, so sibling calls may reuse tool-call IDs without
colliding. The native fixture executes both siblings, consumes their actual
model-visible continuation actions to reconstruct all bytes, then reconstructs
the database engine and recovers the same content from hydrated child envelopes.
The public child-stream decoder receives those same artifact envelopes, while
the parent response remains a compact summary.
This preserves root-scoped reader authority and the existing reset/expiry path.
Missing native child identity or a permission-eligible reader is a visible error.
User personas without an explicit tool list include the read-only artifact reader
by default; an explicit list remains authoritative and never gains tools implicitly.
Native request context is parsed through the public memory parser across ESM/CJS
builds; malformed memory still fails. Root artifacts retain the host-bound thread
identity rather than accepting a tool-supplied execution scope.

The normal native desktop parity fixture also compares lifecycle data in its
exact live position, including the tool-start event after its tool part. A
scoped start uses its existing native message/tool-call identity as that
hydration anchor; timestamps alone reorder activity when several parts share
a millisecond. Multiple matching tool boundaries remain distinct, and removed
unfinished calls keep their failure journal without fabricated tool parts.
Legacy timeline placement is unchanged. This is full content/event ordering for
the tested normal turn, not a claim about every resume leg or the still-pending
child receiver.

Hydration deduplicates tool calls within one assistant group, preserving progressive
snapshots without removing a same-id tool in a later turn or regenerated sibling.
The native message assignment precedes tool anchoring; a trailing tool releases
its lifecycle queue through the normal final flush. The paired hydration regression
covers reused native tool ids across turns and their separate inline results.

Scoped tool completion/failure also cannot precede its persisted tool part when
the loaded journal has no start event. The tool boundary is only a lower bound
for terminals: their timestamps still preserve text streamed while the tool was
running. Paired hydration tests cover terminal-only journals and mixed legacy
events without changing content order or fabricating missing parts.

### Renderer receiver and native transcript ownership (BST-1719)

The optional panel/runtime `onDelegatedConversation` callback receives full,
ephemeral child snapshots through the ordinary decoder and accumulator, keyed
by native invocation across observed message changes. Full replay replaces
snapshots; native memory remains the sole transcript writer. Missing terminals
and unseeded/mismatched replay openings fail visibly. Child error isolation,
recursive descendants, cancellation and upstream-fault settlement are covered
at the public runtime adapter; the desktop native fixture now tests that adapter
against the reconstructed persisted transcript. See the renderer receiver
contract in `assistant-runtime.md` for lifecycle and remaining acceptance scope.
Child tabs/rendering and durable graph association remain BST-1724 work.

Receiver completion uses the same `deferMessageFinishUntilFlush` transform as the
parent. Both final part streams and descendant receivers settle before a complete
snapshot is published. Producer failures/cancellations still emit their required
`d` finish frame; an error frame alone is a truncated stream, not a valid child
terminal. Cleanup preserves the primary transport/envelope/abort failure and logs
secondary settlement failures once. Consumer presence selects receiver installation
at run start; an installed receiver reads the latest committed callback on each
update, including callback replacement during an active run.

The receiver also retains its first observed failure if decoding or descendant
settlement subsequently fails; the competing observer/decoder regression pins
this through the public runtime adapter.

### Native child response boundaries across resume (BST-1719)

Persona children install `createResponseBoundaryProcessor` through Mastra's
public `processOutputStep` hook. A response step without tool calls marks its
last native assistant row using `MessageList.markResponseMessageBoundary`.
Tool steps stay open for their results and ordinary continuation. The processor
neither mints message IDs nor removes repeated text or tool content.

At core 1.64.0, `Agent.#executeOnFinish` re-adds the response rows to the same
message list. After approval resume rotates the native assistant ID, re-adding
an earlier row can otherwise merge its text into the new continuation row.
The boundary prevents that merge before native persistence runs. This uses the
public processor/message-list API; no vendor patch or second content writer.
Core seals the pre-approval row when it rotates the response ID; the processor
seals the new continuation row before finish re-adds the earlier rows. A boundary
miss is an explicit integrity error, never permission to persist known-ambiguous
history. The processor leaves the existing content intact when reporting it.

The desktop native verifier runs parent → child → grandchild approval and
decline after rebuilding Mastra and the database engine. It compares text
across live stream legs with folded history, retains reasoning/tool ordering
and non-empty arguments, checks exactly-once approved execution and zero declined
execution, then reconstructs the database again. Repeated legitimate text in
the continuation remains present. The fixture uses the production projection,
host observer and public child decoder; it does not claim that the pending
BST-1720 approval UI or unrestricted recursive persona factory is enabled.
The fixture installs the real processor on native Agents directly. The persona
factory suite separately verifies production installation, and the direct
MessageList tests cover terminal replay, open tool steps, empty responses and
boundary conflicts.

Reference: [Mastra processors](https://mastra.ai/docs/agents/processors), plus
installed core 1.64.0 public `MessageList` declarations and native finish path.

The same native test pins declined tool hydration: the `output-denied` row
produces the shared live decline envelope with its original arguments and
reason, without reporting success or failure. Approval grants and execution
routing remain native; this change only preserves the already-made decision.
An already persisted valid decline result remains authoritative, including its
reason; native denials without a result use the shared decline constructor.
