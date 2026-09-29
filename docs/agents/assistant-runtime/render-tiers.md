# Render tiers — evidence

Supports `docs/agents/assistant-runtime.md` § "Render tiers".
Read before changing the virtualization threshold, the virtualizer wiring, tier-2 scroll ownership, or the tier-switch anchor. BST-897.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 2440-2568), extracted verbatim.

`ThreadMessagesRegion` picks one of two renderers by message count and
publishes the choice as `data-thread-render-tier` on the viewport — tier
selection is observable, never silent.

**Tier 1 — `static`** (below `THREAD_VIRTUALIZATION_THRESHOLD`, currently 400).
Every message is a real DOM row from `ThreadPrimitive.Messages`; off-screen
rows are cheap via `content-visibility: auto` + `contain-intrinsic-size` in
overrides.css, which keeps find-in-page, selection, screen readers and anchor
links working — that is why it is the DEFAULT tier. Containment is NEVER
applied to the last row: the streaming message grows token by token and a
lagging intrinsic size fights the follow logic. The streaming message is always
the last row and the library's message root carries no "running" attribute, so
`:not(:last-child)` IS the streaming exclusion. Scrolling is exactly as
described above.

**Tier 2 — `virtual`** (at or above the threshold). The list becomes an
end-anchored TanStack virtualizer (`anchorTo: 'end'`, `followOnAppend`,
`getItemKey` = message id, `measureElement`) driven by the library's documented
escape hatch, `unstable_useThreadMessageIds` +
`ThreadPrimitive.Unstable_MessageById`. Mounted rows are bounded by the
viewport, not by thread length.

- **One scroll owner per tier.** On tier 2 the virtualizer writes `scrollTop`,
  so every library-driven scroll is off: `autoScroll={false}` and
  `scrollToBottomOnThreadSwitch={false}`. Never run the library's
  stick-to-bottom hook and the virtualizer on one container.
- **`overflow-anchor: none` is UNCONDITIONAL on tier 2**, via
  `[data-thread-render-tier="virtual"]`, independent of `data-pinned`. The
  pinned-only scoping above is the static tier's rule: it holds because the
  library writes `scrollTop` only while pinned. The virtualizer corrects
  `scrollTop` in every state — item re-measurement fires while the reader is
  scrolled up too — so native anchoring would double-adjust there as well. Two
  independent selectors setting the same value; they never disagree.
- **Measurement corrections are immediate.** The virtual tier overrides the
  static viewport's `scroll-behavior: smooth` with `auto`; explicit user jumps
  still use the virtualizer's smooth option unless reduced motion is enabled.
  Inherited CSS animation can make native correction read-backs look like user
  movement and lose the pin. The shared-renderer browser suite covers this with
  compiled Tailwind styles and Linux Chromium.
- **Native scroll completion.** Tier 2 enables the virtualizer's
  `useScrollendEvent`. Its timer-based reset reports the offset cached by the
  previous scroll event; a reset delivered between row-resize compensations
  can overwrite the newer position and drop the end pin. Native `scrollend`
  reads the current offset. The vendor still uses its timer on engines without
  native `scrollend`; this guarantee applies to supporting engines, including
  the shipped Electron and tested Chromium. The browser regression delivers a held reset
  between two real row reflows, and removing the stale delivery is the negative
  control. Keep this on the virtualizer's public API; do not add another scroll
  writer or a longer reset delay.
- **Virtual layout ownership.** React Virtual's documented `directDomUpdates`
  owns both container size (`containerRef`) and per-item row transforms. React
  sets only the static absolute-position base (`position`/`top`/`left`/`width`), not the container
  height or variable row offsets. Keep the ref composed with list-offset
  measurement and keep the mode constant across static/virtual tier switches.
- **End affordance subscription.** Virtual Core and React Virtual deliberately
  coalesce notifications by visible range and `isScrolling`; that is not an
  end-state subscription. Wrap the exported `observeElementOffset`, call the
  vendor callback first, then publish `isAtEnd()`. Also publish it from
  `onChange` after vendor layout writes for size changes. The wrapper delegates
  observer setup and cleanup unchanged and never writes scroll position.
  A same-range threshold crossing must update the button before `scrollend`;
  the real-browser regression proves this without an incidental React render.
- **Clamped compensation belongs to the vendor.** React Virtual 3.14.11 /
  Virtual Core 3.17.9 recover a measurement adjustment clamped before the size
  container grows, including consumers that synchronously grow it inside
  `onChange`. Keep that patch floor; do not add a second scroll writer or weaken
  the true-bottom assertion. See [upstream #1260](https://github.com/TanStack/virtual/pull/1260).
- **Browser interaction admission.** The shared-conversation matrix observes
  native `scrollend` before simulating its independent scroll-away gesture,
  alongside the real-bottom and loaded-last-row assertions. One animation frame
  can precede pending row measurement and is not a completion signal. Synthetic
  scroll plus event delivery belongs in React `act`; keep geometry capture alive
  through the scroll-away assertion so a failure records both phases. This is
  test synchronization, not a production delay or a relaxed scroll assertion.
- **Opening position.** `scrollToBottomOnInitialize` / `scrollToBottomOnRunStart`
  stay `false` in both tiers. Tier 2's equivalent is explicit: entering the
  virtual tier anchors to the newest message with `behavior: 'instant'` (never
  animated), but only when the reader was not already scrolled up — a thread
  crossing the threshold mid-session must not yank the viewport away. The
  anchor re-arms when `threadKey` changes or when the thread drops back to the
  static tier.
- **Pinnedness at the switch is RECORDED, never measured.** The anchor effect
  runs after the commit that already swapped the renderer, so the viewport is
  sized by the virtualizer's ESTIMATES by then, not the static list's real row
  heights; measuring `scrollHeight` there compares a stale `scrollTop` against a
  size that just changed, and the verdict flips depending on whether the
  estimate happens to run above or below the real height. The static tier's own
  `isAtBottom` is recorded while it is still the truth and read back on the
  swap. **Testing consequence:** a test that scrolls up and then crosses the
  threshold must wait for the LIBRARY to disengage — the jump button rendering
  enabled — not just for `viewport.scrollTop`, which is written synchronously
  and says nothing about the recorded value. Cross while the recorded value is
  still `true` and the swap anchors to the newest message, which is a terminal
  state: the viewport is legitimately pinned and no amount of waiting recovers
  the scrolled-up position.
- **`aria-live` forks per tier.** Every insertion into a live region is an
  announcement. Tier 1's only insertions are new messages, so the viewport stays
  `aria-live="polite"`. Tier 2 mounts and unmounts rows as the user SCROLLS, so
  the same setting would read out every row entering the overscan window; it is
  `off` there until a dedicated new-message live region exists.
- **Reduced motion, tier 2.** The no-explicit-`behavior` rule above is a tier-1
  rule. The virtualizer's behavior argument is not merely forwarded to
  `scrollTo`; it drives the instance's scroll state machine (a `'smooth'`
  scroll suppresses measurement corrections so re-measuring items cannot push
  the target away mid-animation). It therefore must be explicit, and the
  jump button checks `prefers-reduced-motion` itself.
- **One control, one chrome.** Class, icon, label and test id are declared once
  and shared; only the behaviour differs — `ThreadPrimitive.ScrollToBottom` on
  tier 1, `isAtEnd()` / `scrollToEnd()` on tier 2. The button takes plain
  `{ atEnd, jumpToEnd }` values, never the virtualizer: its identity never
  changes, so a child memoized on it would freeze.
- **Message markup never forks.** Both tiers render the SAME components map
  through library primitives; the tier decides which messages mount, never how
  they render. CSS that keyed off "direct child of the viewport" must account
  for tier 2's `.bs-virtual-message` position wrapper.
- **Row spacing must live inside the measured box.** `measureElement` measures
  the border box, so margins on a row — and the virtualizer's `paddingEnd` —
  are invisible to it: margins make consecutive rows overlap, and trailing
  padding outside the measured rows only reaches the DOM on the next React
  commit, so a correction fired while the last message is still growing is
  clamped by exactly that gap and the thread rests just above the true bottom.
  Tier 2 puts inter-message spacing and the trailing gap on the row wrapper as
  padding.

Paired tests: `packages/assistant-ui/src/__tests__/assistant-thread-virtualization.browser.test.tsx`
(real Chromium: tier attribute either side of the threshold, bounded DOM rows at
N=1000 with all messages still reachable, opening at the newest message, append
while scrolled up, streaming growth staying pinned, tier-1 containment computed
styles) and the BST-897 case in `assistant-ui-panel-architecture.test.ts`.
