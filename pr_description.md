## What
Added `aria-hidden="true"` to purely decorative or redundant icons within `PromptCard` and `PromptEditor` components.

## Why
These icons are either purely decorative (accompanied by text labels) or are inside icon-only buttons that already provide context via descriptive `aria-label` or `title` attributes. Without `aria-hidden="true"`, screen readers might read the icon elements unnecessarily, creating a confusing and redundant auditory experience for users relying on assistive technologies.

## Before/After
* **Before:** `Button` components acting as purely icon buttons (like "Add to favorites", "More options", "Restore version") contained icons that could be exposed to the accessibility tree.
* **After:** The `Star`, `MoreVertical`, `RotateCcw`, `Copy`, `Edit2`, `Trash2`, `Globe`, and `Calendar` icons within these interactive contexts explicitly declare `aria-hidden="true"`, cleaning up the accessibility tree.

## Accessibility
* Ensures screen readers ignore these decorative icons, leading to cleaner read-outs.
* Aligns with the best practice of mapping tooltip text exclusively to the `aria-label` or `title` of the interactive element, while hiding the decorative contents.
