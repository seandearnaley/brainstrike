# BST-2288: the pane reload spec observed the workspace writer instead of joining it

`apps/web/e2e/file-tab-pane.test.ts`, "manual close sticks per file across
reload; the toggle reopens", failed all three attempts in the nightly web full
regression lane on a loaded Ubuntu box. It fails in two places:

- Attempt 1 failed at the poll (`:122`). The poll read `paneOpen: true` and hit
  "Timeout 5000ms exceeded".
- Retries 1 and 2 passed the poll. They then failed at `:132`, where the pane was
  still present for the 5 s expect after the reload.

## Defect density (2026-10-21, 14 days, base `a1ca4d3c9`)

Two of the exercised paths are HOT:

- `packages/app-shell/src/thread-workspace` has 5 fix commits: #4100 (BST-2266),
  #4065, #3935, #3624 and #3595. They fix desktop unload, close and reset
  lifecycle, and child-intent races. None of them touches the readiness of a
  thread's workspace. #4100 added the unload flush that this fix reuses.
- This spec has 3 fix commits: #3783, #3935 and #4060. #3783 activated the
  default thread. #3935 replaced a `waitForTimeout(900)` with this 5 s poll.
  #4060 made the reload's writes durable.

The design flaw is in the spec. Each fix swapped one bounded observation for
another and never joined the writer's acknowledgement. The check after the
reload never had an acknowledgement to join.

## Evidence from the traces

- **Attempt 1.** The first poll read was issued 40 ms after the close. It took
  2.5 s and returned a row for `app.ts` with `paneOpen: true`. The second read
  was still running when the 5 s budget ran out.
  - While a hydration read is pending, the coordinator writes nothing for the
    active thread. So a row that captured the pane before the close means the
    first hydration had settled before the close.
- **Retry 2.** The first poll read found no row, so the close was parked behind
  the still-pending hydration read. The second read found `paneOpen: false`.
- **Retries 1 and 2, after the reload.** The page snapshot still showed "Loading
  threads… Reading Mastra memory from PGlite". The database queue was busy, and
  the pane's stored state had not yet been applied.

## Mechanism (main, `use-thread-workspace-coordinator.ts`)

1. **The close was saved late.**
   - The close is not an apps change, so it is a 500 ms debounced save (`:45`,
     `:568`).
   - A close made while the first hydration read is pending is parked behind
     that read (`:552-557`). The inherited write then captures it (`:779-782`).
2. **A row with `paneOpen: true` can predate the close.** When the first
   hydration settles after the pane auto-opens, the inherited write captures the
   pane's explicit `open: true` (`:779-782`).
3. **The unload flush cannot carry a parked close.** It sends a snapshot only
   when a debounce timer is pending, and it joins writes, never reads
   (`:474-501`).
4. **After a reload the pane shows its default.** Per-tab pane state is
   session-only. Only the deferred hydration restores it, after the database
   boots (`:746-755`). Until then, an absent entry means the pane is open.

## Delay injection: main's coordinator, no load, temporary seams

The seams were never committed.

| Injected delay | Main's spec flow | Joined flow |
| --- | --- | --- |
| None | pass | pass |
| First hydration held past the pane's auto-open; poll reads delivered 3 s late | **fails at the poll: `paneOpen: true`, Timeout 5000ms** (attempt 1 exactly) | pass |
| First hydration held 7 s (the close is made during hydration) | **fails at the poll: `null`, no row**, on 7 reads | pass |
| Hydration after the reload held 7 s | **fails at `:132`: pane count 1 for 5 s** (retries 1 and 2) | pass |
| Hydration 4 s and poll reads 3 s, applied to the real spec files | main's spec failed 3 of 3 | the patched spec passed 6 of 6 |

Holding the hydration read past the close leaves no row. It does not leave
`paneOpen: true`. Attempt 1's close came after hydration settled, and the poll's
budget ran out before a read could see the debounced write.

## Ruling and fix

This is a test defect. The coordinator behaved as its contract says. The spec
now joins the owner's acknowledgements:

- It joins `ThreadWorkspaceNavigation.whenReady`, before the close and after the
  reload. The coordinator settles it with its own `complete` or `failed`, so it
  rejects when a load fails.
- It runs `prepareRendererClose`, the unload flush desktop runs before every
  reload it owns, and then reads the row once.

The fix removes the poll and the 20 s tab timeout. It adds no timer, retry or
poll.
