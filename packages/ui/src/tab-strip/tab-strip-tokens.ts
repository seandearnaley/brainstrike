/**
 * Tab-strip geometry and state tokens (BST-1836 spec §5). Literal class strings
 * on purpose: Tailwind emits only classes its scanner sees in source text, so a
 * runtime-composed class produces no CSS. Painted values are pinned by
 * `__tests__/tab-strip.browser.test.tsx`, which runs with real Tailwind.
 */

/** Row container; `@container/tab-strip` drives the pinned-label collapse. */
export const TAB_STRIP_ROOT_CLASS_NAME =
  '@container/tab-strip flex min-w-0 items-center gap-1 px-1.5';
/** Standalone strips own their 36px row, hairline and surface. */
export const TAB_STRIP_STANDALONE_CLASS_NAME = 'h-9 shrink-0 border-border border-b bg-muted/30';
/** Embedded strips fill a host header (IdeLayout) that already owns row, hairline and surface. */
export const TAB_STRIP_EMBEDDED_CLASS_NAME = 'h-full flex-1';
/** Scroller: no visible scrollbar; scroll padding keeps a revealed tab clear of the 24px fades. */
export const TAB_STRIP_SCROLLER_CLASS_NAME =
  'flex h-full min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden scroll-px-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';
export const TAB_STRIP_GROUP_SEPARATOR_CLASS_NAME = 'mx-0.5 h-4 w-px shrink-0 bg-border';
/** Strip chrome buttons (New, All tabs); pair with `Button size="icon-xs"` (28px). */
export const TAB_STRIP_ICON_BUTTON_CLASS_NAME =
  'shrink-0 text-muted-foreground hover:text-foreground';

/** Tab shell: 28px pill, 6px radius; the inset focus ring follows the tab button. */
export const TAB_SHELL_CLASS_NAME =
  'group/tab relative flex h-7 items-center rounded-md transition-[color,background-color,box-shadow,opacity] duration-150 motion-reduce:transition-none has-[[role=tab]:focus-visible]:ring-2 has-[[role=tab]:focus-visible]:ring-ring has-[[role=tab]:focus-visible]:ring-inset';
export const TAB_SHELL_SCROLL_WIDTH_CLASS_NAME = 'min-w-24 max-w-56 shrink-0';
export const TAB_SHELL_PINNED_WIDTH_CLASS_NAME = 'shrink-0';
/** Neutral selected = the segmented control's raised surface (one selection language). */
export const TAB_SELECTED_CLASS_NAME =
  'bg-background text-foreground shadow-xs ring-1 ring-border/70';
export const TAB_IDLE_CLASS_NAME = 'text-muted-foreground hover:bg-muted/60 hover:text-foreground';
/** Identity-tinted tabs take their fill from the consumer's appearance classes. */
export const TAB_SELECTED_TINTED_CLASS_NAME = 'text-foreground';
export const TAB_IDLE_TINTED_CLASS_NAME = 'text-muted-foreground hover:text-foreground';
export const TAB_DRAGGING_CLASS_NAME = 'opacity-45';

/** State never changes weight (no width jitter): 12/16 medium everywhere. */
export const TAB_TRIGGER_CLASS_NAME =
  'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pr-1 pl-2 text-left font-medium text-xs leading-4 outline-hidden';
export const TAB_TRIGGER_NO_CLOSE_CLASS_NAME = 'pr-2';
export const TAB_TRIGGER_REORDERABLE_CLASS_NAME = 'cursor-grab active:cursor-grabbing';
export const TAB_LABEL_CLASS_NAME = 'min-w-0 truncate';
export const TAB_PINNED_LABEL_CLASS_NAME = '@max-[520px]/tab-strip:sr-only';
export const TAB_DELETED_LABEL_CLASS_NAME = 'line-through';
export const TAB_ICON_CLASS_NAME = 'size-3.5 shrink-0';

/** 20px close slot with a 28px hit area; visibility changes opacity only, so space is reserved. */
export const TAB_CLOSE_CLASS_NAME =
  "relative mr-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity duration-150 after:absolute after:-inset-1 after:content-[''] hover:bg-foreground/10 hover:text-foreground motion-reduce:transition-none";
export const TAB_CLOSE_IDLE_VISIBILITY_CLASS_NAME =
  'pointer-events-none opacity-0 group-focus-within/tab:pointer-events-auto group-focus-within/tab:opacity-100 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100';
export const TAB_CLOSE_ACTIVE_VISIBILITY_CLASS_NAME = 'opacity-70 hover:opacity-100';
/** Drop indicator sits INSIDE the target's own box, so it needs no z-index. */
export const TAB_DROP_INDICATOR_CLASS_NAME =
  'pointer-events-none absolute inset-y-1 w-0.5 rounded-full bg-primary';

/** Edge fade width in px. Must stay below the scroller's `scroll-px-8` (32px). */
export const TAB_STRIP_FADE_WIDTH_PX = 24;
