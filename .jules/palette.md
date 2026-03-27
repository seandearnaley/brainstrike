## 2026-03-27 - [Added Accessible Labels to PromptCard Favorite Button]
**Learning:** Icon-only buttons representing binary toggle actions (like adding/removing a favorite) often omit `aria-label` and `title` attributes, making them inaccessible to screen readers and lacking native tooltips for mouse users.
**Action:** Always provide descriptive and dynamic `aria-label` and `title` attributes (e.g., 'Add to favorites' / 'Remove from favorites') for icon-only toggle buttons, especially those using `size="icon"` from the UI package.
