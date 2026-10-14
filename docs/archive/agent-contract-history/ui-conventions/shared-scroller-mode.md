# Shared-scroller mode — evidence

Supports `docs/agents/ui-conventions.md` § "TREEGRID CONVERGENCE CONTRACT".
Read before giving a TreeTable its own scrollport inside a scrolling column, or before changing `scrollParentRef`/`scrollMargin` handling.

Extracted verbatim from the pre-distillation contract.

---

  - Sanctioned exception — shared-scroller mode (`scrollParentRef`): when
    MULTIPLE TreeTables stack inside one scrolling column (forest sections),
    that column is the single scroll owner. Each table passes the column via
    `scrollParentRef`; its viewport becomes a non-scrolling spacer
    (overflow-visible, natural height) and the virtualizer windows through
    TanStack `scrollMargin` (offset tracked as sibling sections resize). A
    per-table scrollbar inside a scrolling column is the forbidden shape: the
    viewport stretches to content height, never scrolls, and the virtual
    window freezes (blank rows on scroll, full-height DOM — the forest jank
    regression). Guards: `tree-table-shared-scroller.test.tsx` (structure) and
    the forest e2e virtualization spec in `apps/web/e2e/forest-expand-all.test.ts`
    (bounded DOM + non-blank scroll).

