## 2024-04-30 - Added aria-pressed to toggle buttons
**Learning:** Toggle buttons relying only on active CSS classes and aria-labels do not communicate their active state correctly to screen readers.
**Action:** Always map the boolean state of a toggle/tab mode button to the `aria-pressed` or `aria-selected` attribute respectively for accessible component authoring.
