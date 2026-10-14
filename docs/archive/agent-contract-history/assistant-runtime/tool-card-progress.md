# In-flight tool card progress — evidence

Supports `docs/agents/assistant-runtime.md` § "IN-FLIGHT TOOL CARD PROGRESS".
Read before changing the running tool row's label, its byte counter, or the installed-accumulator contract test. BST-849.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 2574-2609), extracted verbatim.

`ToolFallback`'s running row reads its label from what assistant-stream already
delivers, so a 30–120 s argument stream is no longer indistinguishable from a
hung run: `Receiving input · 12.4 KB · 42.0s` while the model is still sending
argument text, `Running · 44.0s` while the tool executes, and the measured
execution time once the call settles. The pure label lives in
`packages/assistant-ui/src/tool-call-progress.ts`; the hooks in
`use-tool-call-progress.ts`.

- **The signal is the accumulator's `state`, NOT `status.isArgsComplete`.**
  `AssistantMessageAccumulator` (assistant-stream, pinned in lockstep with
  `@assistant-ui/core`) stamps `state: 'partial-call'` on the tool-call part
  it opens, flips it to `'call'` on `tool-call-args-text-finish`, and to
  `'result'` with the result. It ALSO writes `status: { type: 'running',
  isArgsComplete: false }` at creation and never flips that flag, so the typed
  field cannot carry the distinction. `state` is undeclared on
  `@assistant-ui/core`'s public `ToolCallMessagePart`, so
  `readToolCallArgsState` narrows it off the props (the accumulator spreads
  the whole part into the renderer) rather than casting.
- **Fallback is silence, not a claim.** An absent or unrecognised `state`, or a
  `partial-call` part that has received zero bytes (a zero-argument tool, a
  call delivered whole, the window before the first delta), reads as plain
  `Running`. "Receiving input" is asserted only once bytes have arrived.
- **Elapsed comes from `part.timing`** (`startedAt` at part creation,
  `completedAt` with the result), ticking once per second while running via
  `useToolCallElapsedMs`; no timing means no timer — never a fabricated clock.
- **Byte count is incremental** (`useIncrementalUtf8ByteLength`): the
  accumulator only appends, so only the new suffix is encoded per delta —
  re-encoding the whole text per emission is O(n²) allocation on the render
  frame budget.
- **Contract test:** `packages/assistant-ui/src/__tests__/tool-call-args-state.contract.test.ts`
  drives the INSTALLED accumulator through part-start → delta → args-finish →
  result and asserts `state`, `status`, and `timing` at each step. A
  dependency bump that renames `state`, starts flipping `isArgsComplete`, or
  drops `timing` fails there — otherwise the UI would silently revert to
  plain `Running` for the whole stream while every other documented runtime
  behaviour stayed green. Re-derive this section and that test together.
