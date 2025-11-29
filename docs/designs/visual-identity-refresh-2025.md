# BrainStrike Visual Identity Refresh 2025

## Executive Summary

This document outlines a comprehensive visual redesign to differentiate BrainStrike from the ubiquitous shadcn/Tailwind aesthetic while maintaining professionalism, accessibility, and exceptional UX. The goal is to create a distinctive, premium feel that signals "above and beyond" while preserving the low-friction, fast experience users expect.

---

## 1. Design Philosophy

### Core Principles

1. **Quiet Confidence**: Premium tools don't shout. Subtle refinements compound into perceived quality.
2. **Warmth Without Softness**: Move away from clinical cool grays toward approachable warm neutrals.
3. **Motion with Purpose**: Every animation serves feedback or guidance—never decoration.
4. **Sync Transparency**: Local-first means users must always know the state of their data.
5. **Accessibility as Excellence**: High contrast and reduced motion aren't afterthoughts—they're features.

### Competitive Positioning

| Tool | Visual Identity | BrainStrike Differentiation |
|------|-----------------|----------------------------|
| Linear | Cool, minimal, liquid glass | Warmer, more approachable |
| Notion | Playful, emoji-heavy | More focused, developer-centric |
| Raycast | Dark, command-line aesthetic | Broader appeal, light mode first |
| Obsidian | Developer/markdown heavy | More refined, polished feel |
| Arc | Bold, colorful, experimental | More restrained, professional |

**BrainStrike's Niche**: The sophistication of Linear meets the warmth of a well-designed writing tool.

---

## 2. Typography System

### Font Selection: Moving Beyond Inter

**Current**: Inter (ubiquitous, safe, forgettable)

**Proposed Primary**: **Geist Sans** (by Vercel)
- Designed specifically for developer interfaces
- Variable font with optical sizing
- Excellent legibility at small sizes (critical for IDE-like layouts)
- Distinctive without being distracting
- Free and well-maintained

**Proposed Monospace**: **JetBrains Mono** or **Geist Mono**
- Programming ligatures (→, !=, ===)
- Excellent character distinction (0/O, l/1/I)
- Variable weight for visual hierarchy in code blocks

**Alternative Primary Options** (if Geist feels too "Vercel"):
1. **Satoshi** - Premium, geometric yet humanist, €99 for complete family
2. **Urbanist** - Free, neo-grotesque, architectural precision
3. **Plus Jakarta Sans** - Free, geometric, slightly warmer than Geist

### Typography Scale (Refined)

```css
/* Base: 16px with optical sizing enabled */
:root {
  /* Display - Headlines, Hero Text */
  --text-display: clamp(2rem, 4vw, 3rem);      /* 32-48px */
  --weight-display: 600;
  --tracking-display: -0.02em;

  /* Heading 1 - Page titles */
  --text-h1: clamp(1.5rem, 2.5vw, 2rem);       /* 24-32px */
  --weight-h1: 600;
  --tracking-h1: -0.015em;

  /* Heading 2 - Section titles */
  --text-h2: 1.25rem;                           /* 20px */
  --weight-h2: 600;
  --tracking-h2: -0.01em;

  /* Heading 3 - Subsections */
  --text-h3: 1rem;                              /* 16px */
  --weight-h3: 600;
  --tracking-h3: 0;

  /* Body - Primary content */
  --text-body: 0.9375rem;                       /* 15px - slightly larger than 14 */
  --weight-body: 400;
  --leading-body: 1.6;

  /* UI - Interface elements */
  --text-ui: 0.8125rem;                         /* 13px */
  --weight-ui: 500;
  --tracking-ui: 0.01em;

  /* Caption - Secondary, labels */
  --text-caption: 0.75rem;                      /* 12px */
  --weight-caption: 500;
  --tracking-caption: 0.02em;

  /* Micro - Badges, timestamps */
  --text-micro: 0.6875rem;                      /* 11px */
  --weight-micro: 500;
  --tracking-micro: 0.03em;
}
```

### OpenType Features

```css
/* Enable premium typography features */
body {
  font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-feature-settings:
    "kern" 1,     /* Kerning */
    "liga" 1,     /* Standard ligatures */
    "calt" 1,     /* Contextual alternates */
    "ss01" 1;     /* Stylistic set 1 (if available) */
  font-kerning: auto;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* Headlines get tighter tracking */
h1, h2, h3 {
  letter-spacing: var(--tracking-h1);
  font-weight: 600;
}

/* Monospace with programming ligatures */
code, pre, .font-mono {
  font-family: 'JetBrains Mono', 'Geist Mono', 'SF Mono', monospace;
  font-feature-settings:
    "liga" 1,     /* Standard ligatures */
    "calt" 1;     /* Contextual alternates for arrows */
  font-variant-ligatures: contextual;
}
```

---

## 3. Color System: Warm Neutrals

### Philosophy

Replace clinical cool grays with warm neutrals that:
- Reduce eye strain during long sessions
- Create emotional warmth and approachability
- Feel premium without sacrificing professionalism
- Work harmoniously with both light and dark modes

### Light Mode Palette

```css
:root {
  /* === BACKGROUNDS === */
  --bs-bg-base: 30 25% 99%;           /* #FDFCFB - Warm white, primary bg */
  --bs-bg-subtle: 30 20% 97%;         /* #F9F7F5 - Subtle warmth, secondary bg */
  --bs-bg-muted: 30 15% 94%;          /* #F2EFEC - Muted panels, sidebar */
  --bs-bg-emphasis: 30 12% 90%;       /* #E8E4E0 - Active states, hover */

  /* === SURFACES (Cards, Dialogs) === */
  --bs-surface-default: 0 0% 100%;    /* #FFFFFF - Cards stay pure white */
  --bs-surface-raised: 30 30% 99%;    /* #FEFDFB - Elevated surfaces */
  --bs-surface-overlay: 0 0% 100%;    /* #FFFFFF - Modals, popovers */

  /* === BORDERS === */
  --bs-border-subtle: 30 10% 92%;     /* #EEEBE7 - Default borders */
  --bs-border-default: 30 8% 86%;     /* #DDD8D3 - Emphasized borders */
  --bs-border-strong: 30 6% 75%;      /* #C4BCB5 - Focused/active borders */

  /* === TEXT === */
  --bs-text-primary: 25 20% 14%;      /* #2D2520 - Warm near-black */
  --bs-text-secondary: 25 12% 35%;    /* #5A4A40 - Secondary content */
  --bs-text-tertiary: 25 8% 50%;      /* #8B7B70 - Placeholders, captions */
  --bs-text-quaternary: 25 6% 65%;    /* #A89B90 - Disabled, hints */

  /* === PRIMARY ACCENT (Brand Color) === */
  /* Slightly warmer blue, shifting toward indigo for distinction */
  --bs-primary: 235 60% 52%;          /* #4F46E5 - Indigo-ish blue */
  --bs-primary-hover: 235 60% 45%;    /* Darker on hover */
  --bs-primary-active: 235 60% 40%;   /* Even darker on press */
  --bs-primary-subtle: 235 60% 96%;   /* #EFEEFE - Subtle bg */
  --bs-primary-foreground: 0 0% 100%; /* White text on primary */

  /* === SEMANTIC COLORS === */
  /* Success - Desaturated green */
  --bs-success: 152 55% 41%;          /* #2F9E6E */
  --bs-success-subtle: 152 55% 96%;
  --bs-success-foreground: 0 0% 100%;

  /* Warning - Warm amber */
  --bs-warning: 38 92% 50%;           /* #F59E0B */
  --bs-warning-subtle: 38 92% 96%;
  --bs-warning-foreground: 25 20% 14%;

  /* Destructive - Warm red */
  --bs-destructive: 0 72% 51%;        /* #DC2626 */
  --bs-destructive-subtle: 0 72% 96%;
  --bs-destructive-foreground: 0 0% 100%;

  /* Info - Muted blue */
  --bs-info: 210 60% 50%;             /* #3B82F6 */
  --bs-info-subtle: 210 60% 96%;
  --bs-info-foreground: 0 0% 100%;

  /* === SYNC STATUS === */
  --bs-sync-synced: 152 55% 41%;      /* Green - in sync */
  --bs-sync-syncing: 210 60% 50%;     /* Blue - syncing */
  --bs-sync-pending: 38 92% 50%;      /* Amber - pending changes */
  --bs-sync-offline: 25 8% 50%;       /* Muted - offline */
  --bs-sync-error: 0 72% 51%;         /* Red - error */

  /* === INTERACTIVE STATES === */
  --bs-ring: 235 60% 52%;             /* Focus ring matches primary */
  --bs-ring-offset: 0 0% 100%;        /* White offset */
}
```

### Dark Mode Palette

```css
.dark {
  /* === BACKGROUNDS === */
  --bs-bg-base: 240 6% 10%;           /* #19191B - Warm dark, not pure black */
  --bs-bg-subtle: 240 5% 13%;         /* #202023 - Subtle elevation */
  --bs-bg-muted: 240 4% 16%;          /* #27272A - Muted panels */
  --bs-bg-emphasis: 240 4% 20%;       /* #313135 - Active states */

  /* === SURFACES === */
  --bs-surface-default: 240 5% 12%;   /* #1E1E21 - Card default */
  --bs-surface-raised: 240 5% 15%;    /* #252528 - Elevated */
  --bs-surface-overlay: 240 5% 18%;   /* #2C2C30 - Modals */

  /* === BORDERS === */
  --bs-border-subtle: 240 4% 20%;     /* #313135 */
  --bs-border-default: 240 4% 26%;    /* #404046 */
  --bs-border-strong: 240 4% 35%;     /* #545459 */

  /* === TEXT === */
  --bs-text-primary: 0 0% 95%;        /* #F2F2F2 - Primary text */
  --bs-text-secondary: 0 0% 75%;      /* #BFBFBF - Secondary */
  --bs-text-tertiary: 0 0% 55%;       /* #8C8C8C - Tertiary */
  --bs-text-quaternary: 0 0% 40%;     /* #666666 - Disabled */

  /* === PRIMARY (Lighter in dark mode) === */
  --bs-primary: 235 65% 65%;          /* #818CF8 - Brighter indigo */
  --bs-primary-hover: 235 65% 70%;
  --bs-primary-active: 235 65% 75%;
  --bs-primary-subtle: 235 30% 18%;
  --bs-primary-foreground: 240 6% 10%;

  /* Semantic colors adjust for dark mode */
  --bs-success: 152 55% 55%;
  --bs-success-subtle: 152 30% 15%;
  --bs-warning: 38 92% 60%;
  --bs-warning-subtle: 38 50% 15%;
  --bs-destructive: 0 72% 60%;
  --bs-destructive-subtle: 0 50% 15%;
  --bs-info: 210 60% 60%;
  --bs-info-subtle: 210 40% 15%;
}
```

### High Contrast Mode

```css
@media (prefers-contrast: more) {
  :root {
    --bs-bg-base: 0 0% 100%;
    --bs-text-primary: 0 0% 0%;
    --bs-border-default: 0 0% 0%;
    --bs-primary: 235 100% 35%;
    /* 7:1+ contrast ratios */
  }

  .dark {
    --bs-bg-base: 0 0% 0%;
    --bs-text-primary: 0 0% 100%;
    --bs-border-default: 0 0% 100%;
    --bs-primary: 235 100% 75%;
  }
}
```

---

## 4. Component Styling Refinements

### Buttons

```css
/* Base button with refined styling */
.btn {
  /* Subtle shadow for depth */
  box-shadow:
    0 1px 2px hsl(var(--bs-text-primary) / 0.04),
    0 1px 3px hsl(var(--bs-text-primary) / 0.08);

  /* Refined transitions */
  transition:
    transform 150ms cubic-bezier(0.4, 0, 0.2, 1),
    box-shadow 150ms cubic-bezier(0.4, 0, 0.2, 1),
    background-color 100ms ease-out;
}

.btn:hover {
  transform: translateY(-1px);
  box-shadow:
    0 2px 4px hsl(var(--bs-text-primary) / 0.06),
    0 4px 8px hsl(var(--bs-text-primary) / 0.1);
}

.btn:active {
  transform: translateY(0);
  box-shadow:
    0 1px 2px hsl(var(--bs-text-primary) / 0.04);
}

/* Primary button with gradient */
.btn-primary {
  background: linear-gradient(
    180deg,
    hsl(var(--bs-primary)) 0%,
    hsl(var(--bs-primary-active)) 100%
  );
  border: 1px solid hsl(var(--bs-primary-active));
}
```

### Cards & Surfaces

```css
.card {
  background: hsl(var(--bs-surface-default));
  border: 1px solid hsl(var(--bs-border-subtle));
  border-radius: 12px; /* Slightly larger radius */

  /* Subtle lift effect */
  box-shadow:
    0 1px 2px hsl(var(--bs-text-primary) / 0.02),
    0 2px 4px hsl(var(--bs-text-primary) / 0.03),
    0 4px 8px hsl(var(--bs-text-primary) / 0.04);
}

/* Elevated cards (modals, dropdowns) */
.card-elevated {
  box-shadow:
    0 4px 6px hsl(var(--bs-text-primary) / 0.05),
    0 10px 15px hsl(var(--bs-text-primary) / 0.1),
    0 20px 25px hsl(var(--bs-text-primary) / 0.1);
}
```

### Input Fields

```css
.input {
  background: hsl(var(--bs-bg-base));
  border: 1px solid hsl(var(--bs-border-default));
  border-radius: 8px;

  /* Inner shadow for depth */
  box-shadow: inset 0 1px 2px hsl(var(--bs-text-primary) / 0.04);

  transition:
    border-color 150ms ease,
    box-shadow 150ms ease;
}

.input:focus {
  border-color: hsl(var(--bs-primary));
  box-shadow:
    inset 0 1px 2px hsl(var(--bs-text-primary) / 0.04),
    0 0 0 3px hsl(var(--bs-primary) / 0.15);
  outline: none;
}
```

---

## 5. Micro-Interactions & Animation

### Animation Tokens

```css
:root {
  /* Timing */
  --duration-instant: 100ms;
  --duration-fast: 150ms;
  --duration-normal: 200ms;
  --duration-slow: 300ms;
  --duration-slower: 500ms;

  /* Easing */
  --ease-default: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-in: cubic-bezier(0.4, 0, 1, 1);
  --ease-out: cubic-bezier(0, 0, 0.2, 1);
  --ease-spring: cubic-bezier(0.175, 0.885, 0.32, 1.275);
  --ease-bounce: cubic-bezier(0.68, -0.55, 0.265, 1.55);
}

/* Respect user preferences */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

### Key Interactions

#### 1. Button Press Feedback
```css
.btn:active {
  transform: scale(0.98);
  transition: transform 50ms ease-out;
}
```

#### 2. Checkbox Toggle
```css
.checkbox[data-state="checked"] .checkbox-indicator {
  animation: check-in 200ms var(--ease-spring);
}

@keyframes check-in {
  0% { transform: scale(0); opacity: 0; }
  50% { transform: scale(1.2); }
  100% { transform: scale(1); opacity: 1; }
}
```

#### 3. Panel Collapse/Expand
```css
.panel-content {
  transition:
    height var(--duration-normal) var(--ease-out),
    opacity var(--duration-fast) ease;
}

.panel[data-collapsed="true"] .panel-content {
  height: 0;
  opacity: 0;
  overflow: hidden;
}
```

#### 4. Loading Skeleton Shimmer
```css
.skeleton {
  background: linear-gradient(
    90deg,
    hsl(var(--bs-bg-muted)) 0%,
    hsl(var(--bs-bg-emphasis)) 50%,
    hsl(var(--bs-bg-muted)) 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite linear;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

#### 5. Form Validation Shake
```css
.input[data-invalid="true"] {
  animation: shake 400ms ease-out;
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  20%, 60% { transform: translateX(-4px); }
  40%, 80% { transform: translateX(4px); }
}
```

---

## 6. Sync Status Visual System

### Global Sync Indicator (Header)

**Position**: Top-right corner of the main header, always visible.

```
┌─────────────────────────────────────────────────────────────┐
│ BrainStrike                              [●] Synced    [?] │
└─────────────────────────────────────────────────────────────┘
```

**States**:
| State | Icon | Color | Label |
|-------|------|-------|-------|
| Synced | ✓ (filled circle with check) | Green | "Synced" |
| Syncing | ↻ (animated spinner) | Blue | "Syncing..." |
| Pending | ○ (hollow circle) | Amber | "3 pending" |
| Offline | ⊘ (offline icon) | Gray | "Offline" |
| Error | ! (exclamation) | Red | "Sync error" |

**Behavior**:
- Clicking expands a dropdown with details
- Shows last sync time: "Last synced 2 minutes ago"
- If error: Shows retry button
- If pending: Shows number of changes queued

### File/Item Sync Badges

**Position**: Right side of file name in explorer, small badge.

```
├── 📁 Documents
│   ├── 📄 meeting-notes.md    ✓     <- Synced
│   ├── 📄 project-plan.md     ↻     <- Syncing
│   └── 📄 draft.md            ○     <- Local only
```

**Badge Design**:
- 16x16px icon, muted colors by default
- Tooltip on hover: "Last synced 5m ago" or "Pending sync"
- Conflict badge: Orange with "⚠" for merge required

### Sync Conflict Resolution UI

**Trigger**: When same file edited offline on multiple devices.

**Modal Design**:
```
┌─────────────────────────────────────────────────────────────┐
│ ⚠ Sync Conflict: meeting-notes.md                      [X] │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  This file was edited on two devices while offline.        │
│                                                             │
│  ┌──────────────────┐    ┌──────────────────┐             │
│  │ Your Changes     │    │ Other Device     │             │
│  │ Modified: 2m ago │    │ Modified: 5m ago │             │
│  │ ───────────────  │    │ ───────────────  │             │
│  │ [Preview]        │    │ [Preview]        │             │
│  └──────────────────┘    └──────────────────┘             │
│                                                             │
│  [Keep Mine]  [Keep Theirs]  [Keep Both]  [View Diff]      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Offline Banner

**Trigger**: When network connection lost.

**Position**: Below header, full-width, persistent until reconnected.

```
┌─────────────────────────────────────────────────────────────┐
│ ⊘ You're offline. Changes are being saved locally.    [✕]  │
└─────────────────────────────────────────────────────────────┘
```

**Design**:
- Muted background (gray-ish)
- Not alarming—offline is a valid state in local-first apps
- Dismissible but returns if user tries cloud action

---

## 7. Layout Refinements

### Spacing Scale

```css
:root {
  --space-0: 0;
  --space-px: 1px;
  --space-0.5: 0.125rem;  /* 2px */
  --space-1: 0.25rem;     /* 4px */
  --space-1.5: 0.375rem;  /* 6px */
  --space-2: 0.5rem;      /* 8px */
  --space-2.5: 0.625rem;  /* 10px */
  --space-3: 0.75rem;     /* 12px */
  --space-4: 1rem;        /* 16px */
  --space-5: 1.25rem;     /* 20px */
  --space-6: 1.5rem;      /* 24px */
  --space-8: 2rem;        /* 32px */
  --space-10: 2.5rem;     /* 40px */
  --space-12: 3rem;       /* 48px */
  --space-16: 4rem;       /* 64px */
}
```

### Border Radius Scale

```css
:root {
  --radius-none: 0;
  --radius-sm: 4px;       /* Small elements: badges, chips */
  --radius-default: 6px;  /* Inputs, buttons */
  --radius-md: 8px;       /* Cards, panels */
  --radius-lg: 12px;      /* Dialogs, dropdowns */
  --radius-xl: 16px;      /* Large cards */
  --radius-2xl: 24px;     /* Hero sections */
  --radius-full: 9999px;  /* Pills, avatars */
}
```

### Panel Headers (Refined)

```css
.panel-header {
  padding: var(--space-2) var(--space-3);
  background: hsl(var(--bs-bg-subtle));
  border-bottom: 1px solid hsl(var(--bs-border-subtle));

  /* Subtle gradient for depth */
  background: linear-gradient(
    180deg,
    hsl(var(--bs-bg-subtle)) 0%,
    hsl(var(--bs-bg-muted)) 100%
  );
}

.panel-title {
  font-size: var(--text-ui);
  font-weight: 600;
  color: hsl(var(--bs-text-secondary));
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
```

---

## 8. Accessibility Enhancements

### Focus Indicators

```css
/* Visible focus ring for keyboard navigation */
:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px hsl(var(--bs-bg-base)),
    0 0 0 4px hsl(var(--bs-primary));
}

/* Remove default focus for mouse users */
:focus:not(:focus-visible) {
  outline: none;
  box-shadow: none;
}
```

### Skip Links

```html
<a href="#main-content" class="skip-link">
  Skip to main content
</a>
```

```css
.skip-link {
  position: absolute;
  top: -100%;
  left: 50%;
  transform: translateX(-50%);
  padding: var(--space-2) var(--space-4);
  background: hsl(var(--bs-primary));
  color: hsl(var(--bs-primary-foreground));
  border-radius: var(--radius-default);
  z-index: 9999;
}

.skip-link:focus {
  top: var(--space-4);
}
```

### Color Blind Considerations

- Never rely solely on color to convey state
- Sync icons include shape differentiation (✓, ↻, ○, !, ⊘)
- Error states include both color AND icon/text

---

## 9. Implementation Roadmap

### Phase 1: Typography (Week 1-2)
- [ ] Download and integrate Geist font family
- [ ] Update font-face declarations
- [ ] Implement new typography scale
- [ ] Enable OpenType features (kerning, ligatures)
- [ ] Test across all components
- [ ] Verify no layout shifts from font change

### Phase 2: Color System (Week 3-4)
- [ ] Define new CSS custom properties
- [ ] Create migration map from old to new variables
- [ ] Update globals.css with new palette
- [ ] Test all components in light mode
- [ ] Test all components in dark mode
- [ ] Implement high contrast mode
- [ ] WCAG contrast audit

### Phase 3: Component Refinements (Week 5-6)
- [ ] Update button styles (shadows, gradients)
- [ ] Refine card/surface styling
- [ ] Update input focus states
- [ ] Apply new border radius scale
- [ ] Update panel headers

### Phase 4: Micro-Interactions (Week 7-8)
- [ ] Implement button hover/active states
- [ ] Add skeleton loaders
- [ ] Add form validation animations
- [ ] Add panel transition animations
- [ ] Test with prefers-reduced-motion
- [ ] Performance audit (no jank)

### Phase 5: Sync Status UI (Week 9-10)
- [ ] Design sync status components
- [ ] Implement global sync indicator
- [ ] Add file sync badges
- [ ] Create offline banner
- [ ] Build conflict resolution modal
- [ ] Integration testing

### Phase 6: Polish & QA (Week 11-12)
- [ ] Cross-browser testing
- [ ] Accessibility audit
- [ ] Performance profiling
- [ ] User testing feedback
- [ ] Final adjustments

---

## 10. File Changes Required

| File | Changes |
|------|---------|
| `packages/fonts/` | Add Geist font files |
| `packages/ui/src/globals.css` | New color variables, typography |
| `packages/tailwind-config/tailwind.config.js` | Updated theme config |
| `packages/ui/src/button.tsx` | Updated styling |
| `packages/ui/src/card.tsx` | Updated styling |
| `packages/ui/src/input.tsx` | Updated styling |
| `packages/ui/src/layout/*.tsx` | Panel refinements |
| `packages/ui/src/sync-status/` | New component (create) |
| `apps/web/src/app/globals.css` | Font imports |

---

## 11. Success Metrics

1. **Visual Distinction**: Blind test - can users identify BrainStrike vs generic shadcn site?
2. **Accessibility Score**: Lighthouse accessibility ≥ 95
3. **Performance**: No increase in Core Web Vitals (LCP, FID, CLS)
4. **User Sentiment**: Qualitative feedback on "premium feel"
5. **Contrast Compliance**: All text meets WCAG AA (4.5:1 minimum)

---

## Appendix A: Font Loading Strategy

```html
<!-- Preload critical fonts -->
<link rel="preload" href="/fonts/geist/GeistVF.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/geist/GeistMonoVF.woff2" as="font" type="font/woff2" crossorigin>
```

```css
@font-face {
  font-family: 'Geist';
  src: url('/fonts/geist/GeistVF.woff2') format('woff2-variations');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: 'Geist Mono';
  src: url('/fonts/geist/GeistMonoVF.woff2') format('woff2-variations');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}
```

---

## Appendix B: CSS Variable Migration Guide

| Old Variable | New Variable |
|--------------|--------------|
| `--bs-background` | `--bs-bg-base` |
| `--bs-foreground` | `--bs-text-primary` |
| `--bs-muted` | `--bs-bg-muted` |
| `--bs-muted-foreground` | `--bs-text-tertiary` |
| `--bs-border` | `--bs-border-default` |
| `--bs-primary` | `--bs-primary` (no change) |
| `--bs-secondary` | `--bs-bg-subtle` |

---

*Document Version: 1.0*
*Created: 2025-11-29*
*Author: Claude Code*
