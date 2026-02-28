## 2026-02-28 - Native Tooltips for Layout Structural Elements
**Learning:** Icon-only buttons handling major structural layout changes (like showing/hiding panels) often have `aria-label`s but lack `title` attributes. Adding a simple `title` attribute provides a native, zero-dependency tooltip on hover, significantly improving discoverability for mouse users without adding extra components.
**Action:** Always verify that structural layout toggles have a `title` attribute that matches or complements their `aria-label` to ensure functionality is easily discoverable.
