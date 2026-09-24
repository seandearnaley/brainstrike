# Assistant Controls — evidence

Supports `docs/agents/ui-conventions.md` § "Composer Controls".

## Composer Controls redesign (BST-1806)

The September 2026 screenshots show 104 enabled native and Linear tools. Long
inline descriptions make tool flyouts exceed the viewport, while Output & Limits
places inputs, switches and computed values into two undersized columns.

Controls uses the shared Popover because it contains editable form fields.
Expandable sections preserve the previous grouping without off-screen submenus;
search and compact tool rows keep larger registries usable. Descriptions remain
available through a click, tap or keyboard disclosure on each row. Provider
controls use full-width labeled rows with help text.

The redesign retains provider capability gates and setting-update semantics.
Draft fields commit on blur or Enter, refuse invalid values, and discard on
Escape. Dismissal and disclosure tests guard against unmounting an uncommitted
draft; replacing a menu does not by itself prove that outside-click ordering is
safe. Browser tests use real styles and measure painted geometry, not just class
names.

Real Chromium measurements at an 800px viewport height, with package styles:

| Measurement | Before | After |
| --- | --- | --- |
| Limits at 375px viewport width | 420px submenu, left edge −392px | 351px panel, left edge 12px |
| Narrow panel horizontal scroll | Off-screen submenu | 349px scroll width = 349px client width |
| Panel at 1280px viewport width | 340px root + 420px submenu | One 480px panel |

Baseline captures use package CSS for geometry only; the redesigned captures
also load the web app's theme. Adding the theme left the new geometry unchanged.

`assistant-controls-rendered.browser.test.tsx` guards viewport containment with
a native/MCP inventory; the draft browser suite covers Tab, caret/slider arrow
keys, outside/trigger dismissal, disclosure collapse, refusal and Escape.
