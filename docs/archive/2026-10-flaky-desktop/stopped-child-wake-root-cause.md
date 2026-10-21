# BST-2287: the scripted parent delegated again from its stopped child's wake

`delegated-worker-write.desktop.test.ts`, "stops a reloaded pending child and
preserves parent interaction", expected the root's runs `[command,
wake(cancelled), command]` and received `[command, wake(cancelled),
wake(returned)]` once, on a loaded Ubuntu box.

## Defect density (2026-10-21, 14 days, base `a1ca4d3c9`)

The exercised product paths include three HOT files. `model-provider-shim.ts` has
7 fix/test commits, `state-store-host-memory.ts` has 4 and `core.ts` has 4. The
other paths are below the limit: `core-child-runs.ts` 2, `run-branch.ts` 1,
`child-delivery.ts` 0, and this spec 1. The HOT commits fix other failures:

- recall and compaction (#3952, #3776, #3985, #4088)
- cassettes and egress refusals (#3753, #3742)
- tool-input deltas (#3713) and workspace isolation (#3594)
- stopped reply text (#3569) and typed memory failures (#3966)
- memory settling after the answer (#3731) and titles (#3720)
- runtime failures (#3590) and checked-file scope (#3585)

None of them touches wake delivery or the delivery overlay. No nightly-alert
issue from the last 14 days names this spec or wake delivery. The fix changes
none of the HOT files.

## Mechanism

1. A background dispatch answers the parent's tool call with the acknowledgement
   "Background task started. …" (`child-runs.ts` `hostChildStarted`).
2. By design (BST-1932), a delivered outcome replaces that acknowledgement in the
   parent's provider history. `overlayHostChildOutcomes` in `child-delivery.ts`
   does this, and `state-store-host-memory.ts` applies it, including the
   current wake's own delivery. A stopped child's outcome reads "Subagent
   "Worker" was stopped before completing the task. …". In the failed run, the
   wake request's accounting shows that tool output at 40 tokens. The
   acknowledgement would have been 42.
3. The spec's scripted parent answered only when the history held the
   acknowledgement or the child's result, and otherwise delegated. The stopped
   child's wake holds neither, so **every** run delegated a second Worker from
   the wake. The failed run shows it at root seq 52-53. Locally, the new
   assertion failed 3/3 on main.
4. The second child's first model request raced the spec's
   `provider.setScript`. It usually won, got the worker script and parked at a
   write approval that nobody answered. The test passed with a hidden
   `needs-input` child: a local probe found `Heron … status: needs-input`. In the
   failed run, Ember's request reached the shim about 4 ms after `setScript`.
   Ember answered with the user's scripted text, and its return woke the root
   (run `00eb786e`). The user's `run/start` then reached the host during that
   wake, which refused it with `run.already-active` (`run-branch.ts`
   `assertHostRunStartAvailable`). The renderer logged "The agent host refused
   a run command {code: -32010, method: run/start}", and no committed row
   carries the prompt. Root seq 57 and 70 are the renderer's
   `thread/workspace/set` snapshots after the child tab closed, not user
   turns.

## Ruling: (b), a test defect

The host behaved as its contract says. The wake ledger told the model "Do not
call it again unless the user asks". Only the scripted fake ignored that
instruction. No wake absorbed a command: the refused send was the visible
one-root-run refusal.

## Fix

The scripted parent answers any turn whose last user message quotes the wake
ledger, and never delegates from it. That is the behaviour the ledger asks of a
model. A new assertion requires the stopped child to be the root's only child
before the next answer is scripted. The comment's "settles before the next
answer is scripted" now holds by construction. The fix adds no timer, poll,
retry or product change.
