# Thread scroll follow engine — evidence

Supports `docs/agents/assistant-runtime.md` § "THREAD SCROLLING (STICK-TO-BOTTOM + JUMP-TO-LATEST)".
Read before changing `thread-scroll-follow.tsx`, the jump-to-latest button, `overflow-anchor` scoping, or the own-write echo rule. BST-896, BST-1039.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 2314-2436), extracted verbatim.

Scroll position is owned by the REPO's follow engine
(`packages/assistant-ui/src/thread-scroll-follow.tsx`), never by panel state
and — since the 0.15 upgrade — never by @assistant-ui. The tier-1 scroller is
a PLAIN div wired to `ThreadScrollFollow` (one engine per panel via
`ThreadScrollFollowProvider` in ChatThreadUI): a thread pinned at the bottom
follows streaming growth; the moment the user scrolls up, `isAtBottom` flips
false and the engine stops writing `scrollTop` — streaming can never steal the
reading position back. Re-engaging is an explicit user act.

**Why repo-owned:** the library's `useThreadViewportAutoScroll` broke twice
upstream (0.14.28 and 0.15.x tear down its ResizeObserver on every `isRunning`
flip, silently unpinning follow on every send), and the failure is not
workable at its public API — the scrollTop clamp misread is indistinguishable
from a real user scroll from outside (two app-level workarounds were built and
failed the BST-1039 test; see dependency-updates-breaking-changes.md). The
engine is a parity port of the library's algorithm with a STABLE observer
lifecycle (attached once per scroller element, never re-created by renders) —
the stable lifecycle is the fix. `ThreadPrimitive.Viewport` must not return:
`assistant-ui-panel-architecture.test.ts` pins the plain-div scroller.

Content growth is detected by `MutationObserver`, measured immediately, then
verified in one coalesced `requestAnimationFrame`. Mutation delivery can
precede Chromium's final layout, while a `ResizeObserver` attached to the
scroller does not reliably observe scroll-height-only growth; relying only on
the synchronous read can therefore miss the new bottom. Pointer, wheel, and
touch intent plus detach cancel a pending frame so user navigation, or an
unmounted scroller, cannot receive a deferred follow write.

The scroller, the message list, the button and the engine are one owned
module pair — `assistant-thread-messages.tsx` (`ThreadMessagesRegion`,
`ThreadScrollRegion`, `ThreadScrollToBottom`) + `thread-scroll-follow.tsx`,
re-exported from assistant-ui-panel.tsx. The panel only composes them and
hands over the message components.

Explicit message navigation is supplied by `ThreadMessageNavigationContext`, scoped to one conversation. `ThreadMessagesRegion` waits for loaded history, resolves raw native IDs through the mapper's source-ID metadata, and focuses the corresponding message root. Static navigation calls the existing follow engine's `scrollToMessage` (which disengages following); virtual navigation uses the existing TanStack instance's `scrollToIndex`. Both use an instant opening position and `focus({ preventScroll: true })`, so browser focus is not another scroll owner. A mounted-range observer waits for an offscreen virtual row; no timer or polling loop is involved. The browser virtualization contract covers exact focus and geometry at 40 and 600 rows with the compiled styles, then verifies appending does not repin the reader.

- **Jump-to-latest** (`ThreadScrollToBottom`) is the follow engine's button
  (`ThreadStaticScrollToBottom`): DISABLED
  while at bottom, scroll + re-engage when clicked; we style it
  (`.bs-scroll-to-bottom`, hidden via `:disabled { opacity: 0 }` — no layout
  shift either way). It mounts inside `ThreadScrollRegion` as a SIBLING of the
  scroller, not a child, so it stays anchored ~1rem above the composer instead
  of scrolling away; that works outside the scroller element because the
  follow engine lives in `ThreadScrollFollowProvider` context above both.
- **No explicit `behavior` on explicit scrolls.** An explicit option bypasses
  CSS `scroll-behavior`, and therefore the global `prefers-reduced-motion`
  override in globals.css — the engine's `scrollToBottom()` deliberately omits
  it so `scrollTo`'s default routes through CSS. Streaming growth follow is the
  exception: `'instant'`, because CSS smooth cannot keep up with per-token
  growth (same stance the library took).
- **`overflow-anchor: none` is SCOPED to the pinned state** via `data-pinned`
  on `.bs-thread-scroll-region` (mirroring `isAtBottom`). Pinned, JS owns
  `scrollTop` and native scroll anchoring would double-adjust. Scrolled up, the
  library writes nothing, so native anchoring is the ONLY thing holding the
  reader's text still when content ABOVE the fold resizes (async markdown/Shiki,
  images resolving, tool cards or chain-of-thought folds collapsing, edit
  composers swapping in). Disabling it unconditionally makes the text jump —
  do not "simplify" this back to a blanket rule.
- **No jump on attach or run start** (the library's
  `scrollToBottomOnInitialize`/`scrollToBottomOnRunStart` equivalents) — that
  is the reload-hydration stance in assistant-persistence.md: reopening a
  thread restores its position instead of jumping to the newest message. The
  ONE navigation jump is the thread SWITCH (`switchKeyRef` in
  ThreadMessagesRegion → `jumpToBottomInstant()`), parity with the library's
  `scrollToBottomOnThreadSwitch`; it requires a `threadKey` prop and never
  routes through the explicit-request listeners.
- There is deliberately NO collapsed-history affordance (removed in BST-896):
  every message renders. Which messages MOUNT is the render tier's business —
  see below.
- **Follow-up queue dispatch re-pins explicitly when the thread was pinned**
  (BST-1039). The flush unmounts the composer's chip row, and the browser's
  resulting `scrollTop` clamp can be misread as a user scroll by the follow
  engine's bookkeeping — silently unpinning follow with no user act. The
  dispatch in `follow-up-queue.tsx` captures `getIsAtBottom()` BEFORE the
  flush and fires the engine's `scrollToBottom` after appending; a reader who
  scrolled up is never yanked. Do not "simplify" this away as redundant with
  the engine's own resize re-stick — that path loses the clamp-ordering race.
- **A `scroll` event the engine itself authored never disengages follow.**
  A `measure` write claims the `scrollTop` it MOVED to (`unechoedWriteTop`) and
  the scroll listener swallows that one echo. A scroll event carries no position
  of its own — `handleScroll` reads LIVE geometry — and `measure` writes
  `scrollTop` synchronously and judges the result in the same breath, clearing
  `pendingFollow`, while the browser dispatches that write's event a task
  LATER. Resize the viewport in between and the leftover event is judged
  against dimensions the engine has never measured ("not at bottom, position
  did not move down"), which is indistinguishable from a reader parked above
  the end; follow then disengaged with no user act and never recovered,
  because `measure` only re-sticks while pinned. The chip row mounting
  (shrinks the viewport from OUTSIDE the scroller) plus a streamed chunk
  (grows the content inside it) is exactly that window, and neither fires a
  scroll event of its own. Two rules follow, both load-bearing:
  **authorship is the discriminator, not movement** — scroll events coalesce,
  so a user round trip to the end and back arrives as ONE event whose net
  movement against the last PROCESSED position is zero (the tier-switch suite
  relies on that event still disengaging); and **`lastScrollTop` is not the
  position before the current event**, it is the last one `handleScroll`
  processed. This was a ~9% `Browser tests` flake in
  `follow-up-queue-repin.browser.test.tsx`, always landing exactly
  `Δclient + Δscroll` px short of the bottom.
  Two placement rules keep the claim honest, and neither is optional.
  It is made in `measure` and NOT in `write`, because the justification for
  swallowing an echo is the synchronous `handleScroll` that only `measure`
  performs: the explicit-request writes (`scrollToBottom` — the jump button and
  the BST-1039 dispatch re-pin — and `jumpToBottomInstant`) never judge, so
  their echo is the ONLY thing that can re-pin the thread. Swallowing it leaves
  the jump button stuck on, which the default CSS smooth scroll hides and a
  **reduced-motion** user (`scroll-behavior: auto`, so the write lands
  synchronously) hits immediately — that is the third case in the paired suite.
  And only a write that MOVED the position is claimed: a no-op write dispatches
  no scroll event, so its claim could never be consumed and would linger until
  some unrelated event happened to land on that exact pixel.

Paired tests: `packages/assistant-ui/src/__tests__/assistant-scroll-to-bottom.browser.test.tsx`
(real Chromium against the real follow engine: pinned/unpinned button states,
click-to-bottom, growth below vs ABOVE the reading position, anchor scoping,
and the own-write echo — that suite forces the squeeze, the growth and the
stale event into ONE synchronous task so neither observer can have measured,
which is the interleaving CI produced under load),
the BST-896 case in `assistant-ui-panel-architecture.test.ts`, which pins the
plain-div scroller, the engine wiring, the absent `behavior`, and the scoped
CSS rule, and `follow-up-queue-repin.browser.test.tsx` (BST-1039: real chips +
real bridge — pinned dispatch requests the explicit re-pin, scrolled-up
dispatch never does).
