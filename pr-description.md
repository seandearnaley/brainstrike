**What:** Add `aria-pressed` attributes to the `Compact`, `Balanced`, and `Insights` toggle buttons in the preview panel footer.
**Why:** To improve screen reader communication by explicitly mapping the component's boolean state to `aria-pressed`.
**Before/After:** The buttons previously relied only on CSS classes and `aria-label` for state indication; now they correctly use `aria-pressed` indicating active state.
**Accessibility:** Ensures accurate screen reader announcements for the currently active summary mode toggle.
