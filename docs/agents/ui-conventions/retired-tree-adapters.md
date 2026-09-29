# Retired tree adapters — evidence

Supports `docs/agents/ui-conventions.md` § "TREEGRID CONVERGENCE CONTRACT".
BST-1211 / BST-1213. Read before looking for the collection browser or the Context explorer's grouped preview table as TreeTable adapters.

Extracted verbatim from the pre-distillation contract.

---

- Prefer adapting feature surfaces to TreeTable API over duplicating tree render logic in app/package code.
- The Explorer file tree (left nav) is the reference treegrid. BST-1211 retired
  the Context explorer's grouped preview table, so the context preview is no
  longer a treegrid adapter — its only surface is the Tapestry gallery.

---

When modifying TreeTable strategy or pagination behavior:
- Update the related file explorer / workspace-search adapters.
  (Two adapters have since dropped out: the collection browser, retired by
  BST-1213 — its jobs live in the Explorer import action and the Explorer|Search
  panel — and the context preview table, retired by BST-1211.)
- Add or update tests validating grouped slicing semantics and selection correctness.
- Document intentional tradeoffs (e.g., paged vs virtual) in code comments or PR notes.

