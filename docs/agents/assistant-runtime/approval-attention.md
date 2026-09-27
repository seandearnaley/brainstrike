# Pending approval review

Supports `assistant-runtime.md` § "PERMISSION ENGINE (TOOL APPROVAL)" and
`assistant-persistence.md` § "ASSISTANT RUN NOTIFICATIONS".

The 2026-09-27 desktop report exposed an approval far above the current scroll
position. The timeline remains a chronological record; the composer now opens a
separate view of the existing pending-decision index. Requests retain global
timeline order across risk categories and use flat cards rather than recursive
indentation. Non-policy approvals are included, without inventing category grants.

The review uses the same owner resolver, previews and decision hook as the
timeline. Submission locks and delivery errors are lifted from each card into
one thread-scoped React provider, keyed by leaf and attempt outcome. Closing
the popup cannot unlock the timeline or hide a rejected delivery; late responses
from a previous attempt cannot overwrite a newer one. Thread changes reset the
provider and close the popup. Commands and working directories remain visible; other tool arguments
are shown with the existing explicit preview-size bound. No decision store,
execution route, polling loop or persistence was added. Answered requests leave
the pending view while their timeline records remain.

The shared Radix Popover supplies focus management, Escape dismissal, collision
handling and a viewport-bounded portal. Opening is explicit so arriving requests
do not steal keyboard focus. Reference: https://www.radix-ui.com/primitives/docs/components/popover

Existing opt-in system notifications continue through the Web Notifications API.
Permission remains a user gesture in Settings; command contents never enter an
OS notification. Reference: https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API
The notification bridge now uses the same canonical leaf decision key as the
UI: a regression demonstrated that root/child copies notified twice, while a
later leaf behind the same parent alias could be suppressed.

Guards: `approval-queue-strip.test.tsx` exercises ordering, verified identity,
command/cwd visibility, exact one-shot dispatch and Escape focus restoration;
`use-assistant-run-notifications.test.ts` exercises leaf-level coalescing;
`delegated-worker-write.desktop.test.ts` approves/declines through the real popup
after reload, then verifies both root and child have no actionable approval.
