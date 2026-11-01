# Child conversations: interaction contract (BST-1717)

- **Status:** design study from before child threads shipped. Child threads now run in the agent
  host ([subagent contract](../../agents/assistant-subagents.md),
  [ADR-0028](../../adr/0028-cross-host-subagents.md)); treat this as UI intent, not a
  description of current code.
- **Prototype:** `index.html` is a self-contained study with no app store, agent calls or
  external dependencies. Open it directly, or run
  `python3 -m http.server 8768 --bind 127.0.0.1` here and visit <http://127.0.0.1:8768/>.
  - Its sessionStorage is confined to this origin; **Reset** clears it. Malformed saved state
    shows a recovery screen instead of being discarded.
  - The State selector walks through every run outcome. No command, model call or file write
    happens.

## Experience

- **Parent entry:** a concise chronological delegation row using the existing activity grammar.
  - **Cedar · Explorer** and **Flint · Explorer** are two invocations of one persona. Name, mark,
    identity and result belong to the invocation; **Explorer** is the role.
  - The call sign never replaces the persona ID in execution, permissions or routing.
- **Opening a child:** one click activates its tab (or opens one).
  - The same thread surface shows delegated instructions, text, reasoning, tools, approvals and
    artifacts.
  - The header names the parent and working folder; the composer names the recipient.
  - Children can delegate further (Wren) with the same navigation. Ancestry is a data tree; the
    UI does not recursively mount transcripts.
- **Identity:**
  - Tabs, parent entries and sidebar rows share call sign, colour and glyph
    (`ASSISTANT_THREAD_COLOR_PRESENTATION`: blue/sky, violet, emerald, amber, rose, slate).
  - Names are unique per root tree, generated once, persisted, stable across reload. An exhausted
    pool adds a numeric suffix.
  - Renaming keeps the immutable invocation ID and original call sign in details.
  - Colour is never identity or status; production pairs it with an icon and the visible call
    sign.
- **Sidebar:**
  - Children group under their parent within the existing folder/group organization and never
    appear as separate roots.
  - Search results show ancestry and reveal the matching row.
  - Collapsed ancestors show descendant attention without marking the parent failed.
  - Row status priority: needs-input, running, failed-unseen, done-unseen. Aggregate descendant
    attention is labelled separately.
- **Needs input:** the first visit reveals the request and its buttons; later visits keep the
  saved position, with a **Needs input** header shortcut. An unread badge alone is not enough.
- **Narrow widths:** the conversation keeps the space; **Threads** reveals the hierarchy; tabs
  scroll, breadcrumbs wrap, the composer stays reachable. No nested or ever-indented transcripts.

## Control semantics

- **Close tab:** removes the view only. Run, approval, draft, transcript and row remain. Closing
  the active child focuses its parent; reopening reuses identity.
- **Stop child:** stops that child's run and its descendants (labelled **Stop Cedar branch**,
  with a count). Parent and siblings continue and receive an explicit cancelled outcome.
- **Stop all agents:** from the root, stops the root and all descendant runs, including queued
  work. Transcripts, results and consumed usage stay.
- **Follow-up while running:** persisted, queued for a safe model boundary, with
  queued/delivered/failed acknowledgement (never "delivered" on enqueue). The parent is told of
  the steering and later gets the result with origin and revision.
- **Follow-up after completion:** a new run in the same child conversation; the original outcome
  stays and a new result revision goes to the parent.
- **Approve / decline / answer:** routed to the exact root run, child run and tool call. Parent
  attention links to the same approval instance. One decision resolves all views.
- **Retry failed child:** a new attempt in the same conversation, linked to the failed one, with
  visible extra usage. Successful writes are never replayed automatically.
- **Interrupt to steer now:** distinct from follow-up and stop; waits for tool settlement, then
  applies the message at a safe boundary (BST-1723).

The prototype simulates queue notices, approvals and subtree stops; it proves nothing about
runtime durability or resume routing.

## Root-control parity

A control may not appear enabled for a child until its command and persistence path work. Ticket
numbers are BST-17xx.

- **Composer, attachments, mentions, slash commands:** same components; explicit child
  recipient; child-scoped drafts. Delegate instructions are attributed to the parent, never to
  the user. (1721, 1723, 1724)
- **Tool detail, approvals, reasoning, activity:** full content, existing controls, no second
  renderer; approval state keyed to its real owner. (1719, 1720, 1724)
- **Artifacts and rich messages:** same renderer with child ownership; the parent gets a
  reference, not a second owner. (1719, 1724, 1726)
- **Copy / retry:** copy matches what is shown; retry is an attributed child attempt that keeps
  successful side effects. (1723, 1724, 1726)
- **Edit / branch / restore:** child-local branches. Rewind checks later writes by every writer
  in the shared workspace and is disabled with a reason until safe. (1724, 1726)
- **Stop:** branch vs whole-tree, as above. Closing or navigating never stops a run.
  (1723, 1725)
- **Model / effort / plan / tool controls:** show inherited configuration and permission
  ceiling. Overrides apply to the next child run and cannot widen root permissions. (1721, 1727)
- **Title, icon, colour, organization:** stable call sign and ancestry. Children cannot be
  dragged to another parent or detached. (1718, 1725)
- **Thread search:** index child transcripts under their owner; open the matching child message.
  (1718, 1719, 1725)
- **Copy title / ID:** use the child's durable conversation ID, never a persona ID. (1718, 1725)
- **Export / archive:** no general root equivalent existed; do not add dead child buttons.
  (1728)
- **Delete:** child deletion preserves parent evidence or refuses with a reason; root deletion
  includes descendants. Active branches settle first. (1718, 1725, 1728)
- **Workspace, changes, checkpoints:** inherit the operating root; attribute every write to the
  child; coordinate overlapping writes. (1721, 1726)
- **Context and usage:** separate this conversation's context, its direct usage and inclusive
  subtree cost; count each invocation once; unknown cost stays unknown. (1718, 1719, 1724)
- **Notifications and unread:** exact child origin; attention propagates to collapsed ancestors
  without duplicate notifications. (1719, 1725)

## Shared ownership, not recursive duplication

- **Identity, ancestry, attempts, usage:** the host's thread and run records (BST-1718).
- **Run lifetime:** host-owned. Components subscribe; mounting and unmounting never create or
  kill agents.
- **Transcript surface:** one active transcript per visible pane, not one per descendant. Extract
  shared surfaces only where needed.
- **Delegation card:** `SubagentExecutionCard` + `StepRowHeader`, given a typed open-conversation
  command rather than importing app-shell navigation.
- **Tabs, breadcrumbs, sidebar:** `AssistantThreadTabsWorkspace`, existing presentation tokens and
  the TreeTable adapter. The prototype's tree traversal is not a production algorithm.
- **View state:** existing thread-keyed drafts, viewport and tab stores, extended to child IDs.

## Accessibility

- **Tabs:** the selected tab is the only tab stop; Left/Right/Home/End switch, Delete closes.
  Close buttons are siblings, never nested.
- **Treegrid:** Up/Down/Home/End move focus; Left/Right collapse/expand or move to
  parent/child; Enter/Space activate. Focus is independent of selection. Use TreeTable semantics
  and virtualization.
- **Focus:** opening from a delegation focuses the destination heading; returning restores the
  opener and scroll position; drafts stay with their recipients.
- **Status:** always a glyph and a readable name; call signs stay visible in light, dark and
  forced-colour modes.
- **Narrow viewports:** header, ancestry, transcript and composer stay in view; only the
  transcript and tab strip scroll.

## Still to prove in production

- Real stream hydration and long-transcript virtualization.
- Two visible panes at once.
- Routed approvals and real write conflicts.
- App reload, provider errors and background recovery.
