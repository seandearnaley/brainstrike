# Delegated conversation navigation — evidence

Supports `docs/agents/ui-conventions.md` § "Delegated conversation navigation".
BST-1724 / BST-1725. Read before changing child-thread navigation, breadcrumbs, search paging, disclosure lifecycle, or Needs-input restoration.

Extracted verbatim from the pre-distillation contract.

---

## Delegated conversation navigation (BST-1724 / BST-1725)

- Navigation slice: child cards/tab titles use durable callsigns, with persona role kept separate.
- New callsigns use a larger name set and independently selected color. Previously
  persisted callsigns and colors are never regenerated on reopen.
- The child conversation carries that color through its sidebar row, tab,
  header, reading backdrop, and composer. A delegation card in the parent uses
  the child's color rather than inheriting the parent's tint.
- Breadcrumbs follow validated native owner/root/parent bindings; returning focuses the originating delegation button while mounted, otherwise the canonical destination tab.
- Root thread filters/sort and folders choose the visible roots; child rows remain beneath those roots in durable creation order, never independently selected/reparented by root bulk actions.
- Search includes owned descendants, with one keyboard-selectable option per matched message. Activation revalidates native ancestry and message ownership, activates the owning root through the saved-workspace coordinator, then opens the singleton child tab. Child titles use the durable callsign.
- An older child search match explicitly pages native history backwards in 80-row pages; default hydration stays at 80. The shared transcript focuses the rendered message containing the exact native hit, including coalesced assistant snapshots. Search never appends a message or restarts work.
- Child disclosure is lazy in the shared virtual TreeTable, fifty children initially with explicit Show more.
- Closing a disclosure releases its descendant subscriptions and reopening revalidates metadata.
- Listing rows never mounts child transcripts; only explicitly activated workspace tabs do, using the existing keep-alive/close semantics.
- Read receipts belong to the ephemeral root store, so virtual row unmount does not invent unread activity.
- Reload derives pending decisions from the existing authoritative discovery path; opening/closing/reopening never starts a model.
- Expanded sidebar parents use that same discovery result, validated against each native invocation, to restore Needs input after renderer restart without mounting transcripts. Only pauses without a durable decision mark Needs input; claimed, consumed, interrupted and cancelled decisions are non-actionable even when stale. Each expanded parent makes one discovery request, and unavailable or conflicting discovery renders an explicit list error. Current live child status takes precedence over the saved attention snapshot.
- Closing a child tab is reversible and reauthorizes before reading history on reopen. Native thread deletion permanently removes the selected subtree and saved conversation data. Neither root nor child threads currently offer an archive operation.
- Free-form steering remains BST-1723 acceptance, not claimed by this slice.

Paired acceptance: `delegated-workspace-reload.desktop.test.ts`, `delegated-worker-write.desktop.test.ts`, `delegated-sidebar-lifecycle.test.tsx`, `delegated-sidebar-rows.test.ts`, `delegated-conversation-ancestry.test.ts`, and `delegated-conversation-store.test.ts`.


## Continuous family accents (2026-09-24)

New child identities use persisted `family:hue:shade` tokens instead of cycling
through the named root swatches. Admission chooses a nearby hue and shade with
separation from the parent and saved siblings; deeper branches use a tighter
hue range. Existing agents retain their identity when more agents arrive or a
root is recolored. The root picker previews new branches without adding palette
configuration. Callsigns, indentation and status remain independent cues.

Navigation uses `getDelegatedColorPresentation`; panels, cards and approvals
resolve the same validated token into light and dark OKLCH variables. Compact
icon tiles replace decorative navigation stripes. Main text retains the theme
foreground, with restrained accent washes on surfaces.

Guards: `packages/types/__tests__/agent-color.test.ts`,
`packages/app-shell/src/__tests__/delegated-workspace-apps.test.tsx`,
`packages/app-shell/src/__tests__/thread-color-family-preview.test.tsx`.
