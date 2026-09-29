# Run-creation seam consumers — evidence

Supports `docs/agents/assistant-runtime.md` § "RUN-CREATION SEAM: WHAT MAY COMPOSE AROUND IT".
Read before composing a new effect around run creation. BST-1115 W5 T4b.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 4198-4228), extracted verbatim.

- **It fires for EVERY run, not every user message.** A tool-approval resume, a
  plan-mode continuation and a stream replay all reach it. Anything that must
  distinguish "the human sent something" needs a SECOND signal:
  `AssistantUiPanel`'s `onThreadRunStart`, which is the composer form's
  `onSubmitCapture` and fires for nothing else.
- **Neither signal is sufficient alone.** assistant-ui's composer input calls
  `form.requestSubmit()` on Enter unconditionally, so an Enter on an EMPTY
  composer fires `onThreadRunStart` and sends nothing (`useComposerSend()`
  returns null). The conjunction — a submit that is FOLLOWED by a run creation
  — is the only honest reading of "a user-authored message started a new run".
- **Conversation Rewind finalization is the first consumer.** `useRewindFinalization`
  holds a read-and-cleared arming flag: `markUserAuthoredSend` (wired to
  `onThreadRunStart`) arms it, and the wrapper's `prepareRequestData` wrapper
  consumes it after the run row exists. That is what ends the one-level redo
  window; see the FINALIZATION bullet in `assistant-persistence.md` for what
  the main process then does.
- **A composed effect MUST NOT be awaited by the send.** `finalizeAfterRunCreated`
  returns `void` deliberately — the send is what the user asked for, and a
  cleanup they did not ask for may never delay or fail it. Report failures
  (log + toast); never swallow them, and never let one reach the composer.
- **An abort that lands after run creation is not a send.** `prepareRequest`
  throws the abort reason once `prepareRequestData` resolves, so the wrapper
  re-checks `abortSignal.aborted` before firing a composed effect. The arming
  flag stays set, and the retry that actually sends fires it.

Paired tests: `assistant-ui-panel-wrapper-rewind-finalization.test.tsx` (the
wiring, including the never-settles and throwing-bridge cases) and
`changes/__tests__/use-rewind-finalization.test.ts` (each half of the
conjunction alone).

When changing this flow, update this section and the paired tests.
