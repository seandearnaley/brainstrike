# Child conversations: interaction contract (BST-1717)

Status: reviewable design; not a shipped child-thread runtime. This is the UI
contract for BST-1724/1725 and the control semantics consumed by BST-1720–1727.
The runtime foundation is BST-1716. Its native Mastra proof does not make this
prototype's simulated actions production capabilities.

**Prototype-only state:** this isolated document owns no application store and
is not loaded by Brainstrike. Its Reset control only resets this study. Malformed
saved state shows a recovery screen; it is never silently discarded. Presentation
constants are reconstructed from the fixture, not trusted from sessionStorage.

Open `index.html`, or serve this directory with
`python3 -m http.server 8768 --bind 127.0.0.1` and visit
<http://127.0.0.1:8768/>. The page has no external dependencies or agent calls.
Its sessionStorage is confined to this design origin and reset by **Reset**;
it is not a new application persistence store. Use the State selector to walk
through every run outcome. No command, model invocation or file write occurs.

## Experience

The parent retains a concise chronological delegation entry, using the existing
activity row grammar. **Cedar · Explorer** and **Flint · Explorer** are two
invocations of the same persona. Their name, colored mark, identity and result
belong to the invocation; **Explorer** is the role. The name must never replace
the persona id in execution, permissions or routing.

Click Cedar once: activate its existing tab, or open one if absent. The same
assistant thread surface displays the delegated instructions, text, reasoning,
tool details, approvals and artifacts. Its header names the parent and working
folder; its composer names the recipient. A child can delegate to Wren, which
opens with the same navigation and rendering contract. Ancestry is a data tree;
the UI does not recursively mount every transcript.

Tabs show the same stable call sign, color and glyph as parent entries and
sidebar rows. Use the existing thread appearance metadata and
`ASSISTANT_THREAD_COLOR_PRESENTATION` tokens (blue/sky, violet, emerald, amber,
rose, slate). Names are unique within the root tree, generated once before the
first event, persisted, and unchanged by reload/resume. An exhausted name pool
adds a visible numeric suffix. User renaming preserves the immutable invocation
id and initial call sign in details. A color is never an identity or a status.
The fixture's letter marks make non-color identity explicit; production uses
the existing semantic icon registry plus the visible call sign.

The main sidebar groups children beneath their parent, preserving the current
folder/group organization of root conversations. Children do not also appear
as unrelated root rows. Search results include ancestry and reveal the matching
row. Collapsed ancestors indicate descendant attention without marking the
parent's own run as failed. Existing row status priority remains needs-input,
running, failed-unseen, done-unseen; aggregate descendant attention is separately
labelled. The fixture displays individual states; aggregate badges and search
are specified here for BST-1725, not implemented by this study.

On first opening a child that needs input, reveal the request and its decision
buttons immediately. Later visits preserve the saved position; the **Needs input**
header shortcut returns to the request. An unread attention badge alone is not
sufficient if the user cannot find the decision.

At narrow widths the conversation keeps the space. **Threads** reveals the
hierarchy; opening a row returns to the conversation. Tabs scroll horizontally,
breadcrumbs wrap, and the composer always stays reachable. No transcript is
squeezed into a nested card or an increasingly indented conversation pane.

## Control semantics

| Action | Scope and result |
| --- | --- |
| Close tab | Remove a view only. Keep the run, approval, draft, transcript and sidebar row. Closing the active child focuses its parent tab; reopening reuses its identity. |
| Stop child | Stop the selected child's active run and any descendants it owns. A node with descendants is labelled **Stop Cedar branch**, with the affected count in production confirmation/details. The parent and siblings continue and receive an explicit cancelled outcome. |
| Stop all agents | From the root, stop the root run and all owned descendant runs, including queued work. Preserve transcripts, results and consumed usage. |
| Direct follow-up while running | Persist a message addressed to the child and queue it for a safe model boundary. Show queued/delivered/failed acknowledgement; never claim delivery on enqueue. Notify the parent of the steering event, then deliver the later result with origin and revision. |
| Follow-up after completion | Continue that child conversation in a new run. Preserve the original delegation outcome; report a new result revision to the parent. Do not rewrite a parent turn already completed. |
| Approve / decline / answer | Route to the exact resource, root run, owning child run and tool-call id. Parent attention links to the same approval instance, not a copied gate. One decision resolves all views; no duplicate execution. |
| Retry failed child | Start a new attempt in the same conversation, with lineage to the failed attempt and visible additional usage. Never replay successful writes automatically. |
| Interrupt to steer now | Explicit lifecycle operation, distinct from queued follow-up and from stop. It waits for tool cancellation/settlement, then applies the message at a safe boundary. BST-1723 owns this runtime contract. |

The fixture simulates queue notices, approval outcomes and subtree stops. It
never proves native background durability or exact resume routing. Those are
separate runtime acceptance gates, not UI optimizations.

## Root-control parity matrix

This inventory describes current root owners found in source. “Same surface”
means reuse the existing implementation with the selected child runtime and
capabilities; it does not assert that children already support that action.
No control may appear enabled until its command and persistence path work.

| Root control and existing owner | Required child behavior | Delivery |
| --- | --- | --- |
| Composer, attachments, mentions and slash commands — `assistant-ui-panel.tsx`, `composer-input.tsx`, `composer-attachments.tsx` | Same components. Explicit child recipient; child-scoped draft and attachment ownership. Delegate instructions have parent attribution, not fabricated user authorship. | 1721, 1723, 1724 |
| Tool detail, approval, reasoning and activity — `assistant-activity-parts.tsx`, `activity-trace.tsx`, `tool-fallback.tsx` | Full original content, chronological grouping and existing controls. No second renderer from compact subagent rows. Approval/question state is keyed to its actual owner. | 1719, 1720, 1724 |
| Artifacts/canvas and rich messages — existing registered tool cards/message parts | Same renderer and artifact opener, with originating child/workspace ownership. Parent receives a result/reference, not a second artifact owner. | 1719, 1724, 1726 |
| Copy/retry — `assistant-action-bar.tsx` | Copy identical displayed content. Retry creates an attributed child attempt; keep successful side effects/checkpoints rather than blindly replaying them. | 1723, 1724, 1726 |
| Edit/branch/restore — `user-message.tsx`, `branch-picker.tsx`, `message-rewind-action.tsx` | Same UI, child-local message branch. A checkpoint rewind must check later writes by every writer in the shared workspace. Disable with a concrete conflict reason until safe; no silent overwrite. | 1724, 1726 |
| Stop — main run lifecycle and composer | Explicit selected branch versus root-tree cancellation, as above. Closing/navigating never stops a run. | 1723, 1725 |
| Model/effort, plan/tool controls — panel model selectors and run controls | Display inherited effective configuration and permission ceiling. Overrides apply to the next child run and cannot expand root permissions. Persona restrictions remain visible. | 1721, 1727 |
| Thread title, icon/color and organization — app-shell tabs and Threads panel | Stable call sign, role and ancestry. Reuse appearance controls. Reorder root siblings normally; do not drag a child into a different parent or silently detach it. | 1718, 1725 |
| Thread search — `threads-panel-search.tsx`, `thread-search-store.ts` | Index full child transcript under its owner, return child matches with ancestry, open the matching child message. | 1718, 1719, 1725 |
| Copy Thread Title / ID — `assistant-thread-context-actions.ts` | Same commands with the selected child's durable conversation id, never a persona id. | 1718, 1725 |
| Export | This research did not find a general root thread export command to reuse. Do not invent parity by exposing a dead child export button. Any future export should explicitly choose conversation-only or the tree, with attribution. | 1728 parity audit |
| Delete — `threads-panel.tsx` confirmation and `onDeleteThread` | Child deletion must preserve referenced parent evidence or reject with the dependency reason. Root deletion includes owned descendants and attachments through the canonical repository/factory reset path. Active branches must settle first. | 1718, 1725, 1728 |
| Archive | No general root conversation archive action was found in the current Threads panel (worktree archive is a different operation). Proposed child archive hides a settled view without destroying parent evidence; do not equate it with worktree deletion. | 1728 parity audit |
| Workspace, changes and checkpoints — `use-assistant-thread-root-binding.ts`, changes surface | Inherit the selected operating root and capability bridge; display the actual workspace. Attribute every write/checkpoint to the child. Coordinate overlapping writes at the workspace boundary. | 1721, 1726 |
| Context/usage — `use-assistant-usage-ledger.ts`, context meter | Distinguish this conversation's context from direct consumed usage and inclusive subtree cost. Root rollups count each invocation once across stream, reload and resume. Unknown cost remains unknown. | 1718, 1719, 1724 |
| Notifications and unread — run lifecycle notification bridge, row status glyph | Exact child origin and link; attention can propagate to collapsed ancestors without duplicating terminal notifications. | 1719, 1725 |

## Shared ownership, not recursive duplication

| Responsibility | Existing owner / intended seam |
| --- | --- |
| Identity, ancestry, ownership, attempts and usage | assistant-contract + assistant-data repository; BST-1718 |
| Native stream → persisted message contract | Node-side Mastra stream mapper and assistant-service; BST-1719. Browser code never imports `@mastra/core`. |
| Active conversation runtime and capability commands | Existing assistant panel/runtime adapter, keyed by durable child conversation identity. Reuse assistant-ui ExternalStoreRuntime where the app already owns the transcript. |
| Messages, viewport/virtualization, scroll, composer | `AssistantThreadMessages` / `AssistantUIPanel`; one active transcript per visible pane, not one per descendant. Extract a shared surface only where required, without a wholesale panel rewrite. |
| Delegation summary/open affordance | `SubagentExecutionCard` + `StepRowHeader`; inject a typed open-conversation command instead of importing app-shell navigation into assistant-ui. Preserve chronological message boundaries. |
| Tabs, breadcrumbs and sidebar | `AssistantThreadTabsWorkspace`, existing thread presentation tokens and TreeTable adapter; no parallel tree implementation in production. The four-node fixture traversal is not a production tree algorithm. |
| View state | Existing thread-keyed drafts, viewport state and active/open-tab stores, extended to child ids and reset through their existing owners. Keep only presentation state while a transcript is unmounted. |
| Run lifetime | Host-owned scheduler/runtime service. Components subscribe; mounting and unmounting do not create or kill agents. |

Vendor reference: [assistant-ui ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)
for externally owned conversation data, and [Mastra subagents](https://mastra.ai/docs/subagents)
for native delegation. Installed-version behavior is pinned by BST-1716, not
inferred from the file-based builder's depth rule.

## Accessibility and behavioral verification

- Tabs: selected tab is the single tab stop; Left/Right/Home/End change tabs,
  Delete closes one. Close controls are siblings, never nested buttons.
- Treegrid: Up/Down/Home/End move focus; Left/Right collapse/expand or move to
  parent/child; Enter/Space activate. Roving focus is independent of selection.
  Production must use the existing TreeTable semantics and virtualization.
- Opening from a delegation focuses the destination heading. Returning through
  ancestry restores the prior opener and scroll position. Switching by tab
  keyboard keeps focus on the selected tab. Drafts stay with their recipients.
- Status has a glyph and readable name; a call sign stays visible in light,
  dark and forced-color modes. This study is static; running it with reduced
  motion checks the settled layout, not the suppression of an animated transition.
- Narrow viewports keep header, ancestry, transcript and composer inside the
  viewport. Only the transcript and overflowing tab strip scroll.
- Tests target rendered behavior, not source-string snapshots. The fixture is
  intercepted as an isolated HTML response in
  `apps/web/e2e/subagent-design-prototype.test.ts`; it is not a production route.
  Its four core navigation/lifecycle checks run in the normal Web E2E smoke
  selection; the full fixture suite runs in the existing functional project.
  These four short cases intentionally protect the active project's interaction
  contract on every PR. BST-1724/1725 should replace them with the equivalent
  production-surface cases as those surfaces land; this does not add a new lane.
  Screenshots use ordinary Playwright attachments for human visual review, not a
  separate proof registry or a substitute for assertions.
- RED: initial Open Cedar had no child tab; test failed. Geometry tests then
  found a one-pixel document overflow. GREEN: child navigation and measured
  region bounds pass after the tab implementation and grid layout fix.

Remaining production proof: real stream hydration, long transcript
virtualization, two simultaneous visible panes, routed approvals, actual
write conflicts, native app reload, provider errors and background recovery.
BST-1728 must verify those through the real web/packaged desktop boundaries and
close every capability row above. A screenshot or this fixture cannot substitute.

Verification checkpoint: 19 deterministic Chromium browser tests passed, including
390px/1280px light/dark viewport bounds, sampled rendered text contrast of at least
4.5:1, and the static layout under reduced-motion preferences. The late lifecycle negative controls cover closing
the final root tab and stopping live descendants after the root itself has finished.
The same tests passed through the checked-in Web E2E functional configuration
with its built preview server. These fixture checks are not production
application E2E proof. Recovery and tampered saved-presentation controls fail on
the original document and pass with explicit state validation. A same-thread
scroll regression passes across state, stop and theme changes; positions clamp
naturally if the new content is shorter. The fixture keeps scroll/draft edits in
memory and saves on navigation or page exit, not on every scroll/keystroke.

Root approval and decline both retain their outcome notice in the root transcript
and reload successfully; the two regression cases failed before correcting the
notice recipient. Child outcomes still notify their immediate parent.
