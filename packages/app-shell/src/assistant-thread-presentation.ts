import type { AssistantThreadColorId, AssistantThreadIconId } from '@brainstrike/assistant-data';
import {
  Bug,
  ClipboardList,
  Code2,
  type LucideIcon,
  MessageSquare,
  Rocket,
  Search,
} from 'lucide-react';

export interface AssistantThreadIconPresentation {
  readonly iconComponent: LucideIcon;
  readonly iconId: AssistantThreadIconId;
  readonly label: string;
}

/**
 * One semantic icon registry for every surface that presents assistant-thread
 * identity. Keeping this beside the shared color/density contract prevents a
 * row, group picker, and open tab from assigning different glyphs to the same
 * durable metadata value.
 */
export const ASSISTANT_THREAD_ICON_PRESENTATION = {
  bug: { iconComponent: Bug, iconId: 'bug', label: 'Bug' },
  code: { iconComponent: Code2, iconId: 'code', label: 'Code' },
  message: { iconComponent: MessageSquare, iconId: 'message', label: 'Message' },
  plan: { iconComponent: ClipboardList, iconId: 'plan', label: 'Plan' },
  research: { iconComponent: Search, iconId: 'research', label: 'Research' },
  rocket: { iconComponent: Rocket, iconId: 'rocket', label: 'Rocket' },
} satisfies Record<AssistantThreadIconId, AssistantThreadIconPresentation>;

/**
 * Missing icon metadata has one documented default. Unsupported persisted
 * values never reach this boundary: the assistant repository rejects them.
 */
export function getAssistantThreadIconPresentation(
  iconId: AssistantThreadIconId | null | undefined
): AssistantThreadIconPresentation {
  return ASSISTANT_THREAD_ICON_PRESENTATION[iconId ?? 'message'];
}

export interface AssistantThreadColorPresentation {
  readonly accentClassName: string;
  readonly groupSurfaceClassName: string;
  readonly idleClassName: string;
  readonly label: string;
  readonly markClassName: string;
  readonly selectedClassName: string;
}

/**
 * Rows are styled with tinted fills plus an inset ring for selection — never
 * hairline borders or accent stripes. Idle rows keep a visible tint of their
 * thread color so unselected threads still read as colored;
 * `accentClassName` remains solely the solid swatch used by color pickers.
 */
export const ASSISTANT_THREAD_COLOR_PRESENTATION = {
  amber: {
    accentClassName: 'bg-amber-500',
    groupSurfaceClassName:
      '[&>td]:bg-amber-50/60 hover:[&>td]:bg-amber-50/80 dark:[&>td]:bg-amber-950/20 dark:hover:[&>td]:bg-amber-950/30',
    idleClassName:
      'bg-amber-100/45 hover:bg-amber-100/75 dark:bg-amber-950/25 dark:hover:bg-amber-950/40',
    label: 'Amber',
    markClassName:
      'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
    selectedClassName:
      'bg-amber-100 shadow-xs ring-1 ring-amber-500/80 ring-inset dark:bg-amber-950/60 dark:ring-amber-400/70',
  },
  blue: {
    accentClassName: 'bg-sky-500',
    groupSurfaceClassName:
      '[&>td]:bg-sky-50/60 hover:[&>td]:bg-sky-50/80 dark:[&>td]:bg-sky-950/20 dark:hover:[&>td]:bg-sky-950/30',
    idleClassName: 'bg-sky-100/45 hover:bg-sky-100/75 dark:bg-sky-950/25 dark:hover:bg-sky-950/40',
    label: 'Blue',
    markClassName:
      'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300',
    selectedClassName:
      'bg-sky-100 shadow-xs ring-1 ring-inset ring-sky-500/80 dark:bg-sky-950/60 dark:ring-sky-400/70',
  },
  emerald: {
    accentClassName: 'bg-emerald-500',
    groupSurfaceClassName:
      '[&>td]:bg-emerald-50/60 hover:[&>td]:bg-emerald-50/80 dark:[&>td]:bg-emerald-950/20 dark:hover:[&>td]:bg-emerald-950/30',
    idleClassName:
      'bg-emerald-100/45 hover:bg-emerald-100/75 dark:bg-emerald-950/25 dark:hover:bg-emerald-950/40',
    label: 'Emerald',
    markClassName:
      'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
    selectedClassName:
      'bg-emerald-100 shadow-xs ring-1 ring-emerald-500/80 ring-inset dark:bg-emerald-950/60 dark:ring-emerald-400/70',
  },
  rose: {
    accentClassName: 'bg-rose-500',
    groupSurfaceClassName:
      '[&>td]:bg-rose-50/60 hover:[&>td]:bg-rose-50/80 dark:[&>td]:bg-rose-950/20 dark:hover:[&>td]:bg-rose-950/30',
    idleClassName:
      'bg-rose-100/45 hover:bg-rose-100/75 dark:bg-rose-950/25 dark:hover:bg-rose-950/40',
    label: 'Rose',
    markClassName:
      'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300',
    selectedClassName:
      'bg-rose-100 shadow-xs ring-1 ring-inset ring-rose-500/80 dark:bg-rose-950/60 dark:ring-rose-400/70',
  },
  slate: {
    accentClassName: 'bg-slate-500',
    groupSurfaceClassName:
      '[&>td]:bg-slate-100/55 hover:[&>td]:bg-slate-100/75 dark:[&>td]:bg-slate-900/25 dark:hover:[&>td]:bg-slate-900/35',
    idleClassName:
      'bg-slate-100/55 hover:bg-slate-100/85 dark:bg-slate-900/30 dark:hover:bg-slate-900/45',
    label: 'Slate',
    markClassName:
      'border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-300',
    selectedClassName:
      'bg-slate-200/80 shadow-xs ring-1 ring-inset ring-slate-500/80 dark:bg-slate-900/70 dark:ring-slate-400/70',
  },
  violet: {
    accentClassName: 'bg-violet-500',
    groupSurfaceClassName:
      '[&>td]:bg-violet-50/60 hover:[&>td]:bg-violet-50/80 dark:[&>td]:bg-violet-950/20 dark:hover:[&>td]:bg-violet-950/30',
    idleClassName:
      'bg-violet-100/45 hover:bg-violet-100/75 dark:bg-violet-950/25 dark:hover:bg-violet-950/40',
    label: 'Violet',
    markClassName:
      'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300',
    selectedClassName:
      'bg-violet-100 shadow-xs ring-1 ring-inset ring-violet-500/80 dark:bg-violet-950/60 dark:ring-violet-400/70',
  },
} satisfies Record<AssistantThreadColorId, AssistantThreadColorPresentation>;

/**
 * Neutral surface for a thread with no durable color. Tabs and rows both need a
 * fill for every thread, so "unassigned" is a real presentation rather than an
 * absence — but it stays neutral instead of guessing a color.
 */
export const UNASSIGNED_ASSISTANT_THREAD_COLOR_PRESENTATION = {
  accentClassName: 'bg-muted-foreground/40',
  groupSurfaceClassName:
    '[&>td]:bg-muted/30 hover:[&>td]:bg-muted/45 dark:[&>td]:bg-muted/20 dark:hover:[&>td]:bg-muted/30',
  idleClassName: 'bg-muted/45 hover:bg-muted/70 dark:bg-muted/30 dark:hover:bg-muted/50',
  label: 'Unassigned',
  markClassName:
    'border-border bg-muted/70 text-muted-foreground dark:border-border dark:bg-muted/45 dark:text-muted-foreground',
  selectedClassName:
    'bg-primary/15 shadow-xs ring-1 ring-inset ring-primary/60 dark:bg-primary/20 dark:ring-primary/70',
} satisfies AssistantThreadColorPresentation;

/**
 * A thread tab and a threads-panel row render the same object, so they share one
 * density and typography contract. Both call sites must consume these tokens
 * instead of re-declaring heights and type sizes, which is how they drifted to
 * 28px/12px and 36px/13px respectively.
 */
export const THREAD_CONTROL_HEIGHT_PX = 28;
export const THREAD_CONTROL_HEIGHT_CLASS_NAME = 'h-7';
export const THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME = 'min-h-7';
/** Control height plus the 2px vertical margin on each side of a panel row. */
export const THREAD_CONTROL_ROW_PITCH_PX = THREAD_CONTROL_HEIGHT_PX + 4;
export const THREAD_CONTROL_TITLE_CLASS_NAME = 'min-w-0 truncate font-medium text-xs leading-4';
/**
 * Pairs with `markClassName`, never `idleClassName`/`selectedClassName`: both
 * surfaces are now tinted with the thread color, so a mark sharing that fill
 * disappears into the control it identifies. `border` (not a ring) supplies the
 * width that `markClassName`'s border color needs.
 *
 * `size-5` rather than `h-5 w-5`: shared button base rules guard on
 * `:not([class*=size-])`, so the paired utilities lose to a 16px base rule.
 */
export const THREAD_CONTROL_MARK_CLASS_NAME =
  'flex size-5 shrink-0 items-center justify-center rounded-sm border';

/**
 * Secondary affordances that sit *inside* a thread control — the tab's close
 * button, the row's expand and actions buttons.
 *
 * 20px, not the Button `icon-xs` 28px: the control itself is 28px tall now, so
 * a 28px chip fills it edge to edge and the hover fill reads as a block rather
 * than a button. 20px leaves 4px above and below. The `after` inset restores a
 * 28px pointer target, keeping it above the 24px guidance.
 *
 * `hover:bg-foreground/10` rather than `bg-muted`/`bg-accent` for the same
 * reason the mark uses `markClassName`: these now sit on a tinted surface, and
 * an opaque neutral fill paints a grey blotch into the tint.
 */
export const THREAD_CONTROL_ACTION_CLASS_NAME =
  "relative size-5 shrink-0 rounded-sm after:absolute after:-inset-1 after:content-[''] hover:bg-foreground/10 hover:text-foreground";

/**
 * Always resolves to a paintable surface. There is deliberately no nullable
 * sibling accessor: a call site that receives `null` has to invent its own
 * unassigned fallback, which is exactly the per-call-site drift this module
 * exists to prevent.
 */
export function getAssistantThreadColorSurface(
  colorId: AssistantThreadColorId | null | undefined
): AssistantThreadColorPresentation {
  if (!colorId) {
    return UNASSIGNED_ASSISTANT_THREAD_COLOR_PRESENTATION;
  }
  return ASSISTANT_THREAD_COLOR_PRESENTATION[colorId];
}

/**
 * Run state a Threads-panel row can report, in the ONE badge slot it spends on
 * run state. See `thread-row-status-glyph.tsx` for the glyphs themselves.
 */
export type ThreadRowStatusState = 'done-unseen' | 'failed-unseen' | 'needs-you' | 'running';

export interface ThreadRowStatusInputs {
  /** The thread's latest run failed and the user has not looked since. */
  readonly failedUnseen: boolean;
  /** The user owes this thread a tool-approval answer. */
  readonly needsYou: boolean;
  readonly running: boolean;
  /** The thread's latest run reached a terminal state after the watermark. */
  readonly unseen: boolean;
}

/** Highest-priority state for one row, or `null` when the row is plain. */
export function resolveThreadRowStatusState({
  failedUnseen,
  needsYou,
  running,
  unseen,
}: ThreadRowStatusInputs): ThreadRowStatusState | null {
  if (needsYou) {
    return 'needs-you';
  }
  if (running) {
    return 'running';
  }
  if (failedUnseen) {
    return 'failed-unseen';
  }
  return unseen ? 'done-unseen' : null;
}
