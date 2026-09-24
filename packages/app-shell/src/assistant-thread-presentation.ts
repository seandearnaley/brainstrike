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
  cyan: {
    accentClassName: 'bg-cyan-500',
    groupSurfaceClassName:
      '[&>td]:bg-cyan-50/60 hover:[&>td]:bg-cyan-50/80 dark:[&>td]:bg-cyan-950/20 dark:hover:[&>td]:bg-cyan-950/30',
    idleClassName:
      'bg-cyan-100/45 hover:bg-cyan-100/75 dark:bg-cyan-950/25 dark:hover:bg-cyan-950/40',
    label: 'Cyan',
    markClassName:
      'border-cyan-300 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-300',
    selectedClassName:
      'bg-cyan-100 shadow-xs ring-1 ring-inset ring-cyan-500/80 dark:bg-cyan-950/60 dark:ring-cyan-400/70',
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
  fuchsia: {
    accentClassName: 'bg-fuchsia-500',
    groupSurfaceClassName:
      '[&>td]:bg-fuchsia-50/60 hover:[&>td]:bg-fuchsia-50/80 dark:[&>td]:bg-fuchsia-950/20 dark:hover:[&>td]:bg-fuchsia-950/30',
    idleClassName:
      'bg-fuchsia-100/45 hover:bg-fuchsia-100/75 dark:bg-fuchsia-950/25 dark:hover:bg-fuchsia-950/40',
    label: 'Fuchsia',
    markClassName:
      'border-fuchsia-300 bg-fuchsia-50 text-fuchsia-700 dark:border-fuchsia-800 dark:bg-fuchsia-950/40 dark:text-fuchsia-300',
    selectedClassName:
      'bg-fuchsia-100 shadow-xs ring-1 ring-inset ring-fuchsia-500/80 dark:bg-fuchsia-950/60 dark:ring-fuchsia-400/70',
  },
  green: {
    accentClassName: 'bg-green-500',
    groupSurfaceClassName:
      '[&>td]:bg-green-50/60 hover:[&>td]:bg-green-50/80 dark:[&>td]:bg-green-950/20 dark:hover:[&>td]:bg-green-950/30',
    idleClassName:
      'bg-green-100/45 hover:bg-green-100/75 dark:bg-green-950/25 dark:hover:bg-green-950/40',
    label: 'Green',
    markClassName:
      'border-green-300 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-300',
    selectedClassName:
      'bg-green-100 shadow-xs ring-1 ring-inset ring-green-500/80 dark:bg-green-950/60 dark:ring-green-400/70',
  },
  indigo: {
    accentClassName: 'bg-indigo-500',
    groupSurfaceClassName:
      '[&>td]:bg-indigo-50/60 hover:[&>td]:bg-indigo-50/80 dark:[&>td]:bg-indigo-950/20 dark:hover:[&>td]:bg-indigo-950/30',
    idleClassName:
      'bg-indigo-100/45 hover:bg-indigo-100/75 dark:bg-indigo-950/25 dark:hover:bg-indigo-950/40',
    label: 'Indigo',
    markClassName:
      'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300',
    selectedClassName:
      'bg-indigo-100 shadow-xs ring-1 ring-inset ring-indigo-500/80 dark:bg-indigo-950/60 dark:ring-indigo-400/70',
  },
  lime: {
    accentClassName: 'bg-lime-500',
    groupSurfaceClassName:
      '[&>td]:bg-lime-50/60 hover:[&>td]:bg-lime-50/80 dark:[&>td]:bg-lime-950/20 dark:hover:[&>td]:bg-lime-950/30',
    idleClassName:
      'bg-lime-100/45 hover:bg-lime-100/75 dark:bg-lime-950/25 dark:hover:bg-lime-950/40',
    label: 'Lime',
    markClassName:
      'border-lime-300 bg-lime-50 text-lime-700 dark:border-lime-800 dark:bg-lime-950/40 dark:text-lime-300',
    selectedClassName:
      'bg-lime-100 shadow-xs ring-1 ring-inset ring-lime-500/80 dark:bg-lime-950/60 dark:ring-lime-400/70',
  },
  orange: {
    accentClassName: 'bg-orange-500',
    groupSurfaceClassName:
      '[&>td]:bg-orange-50/60 hover:[&>td]:bg-orange-50/80 dark:[&>td]:bg-orange-950/20 dark:hover:[&>td]:bg-orange-950/30',
    idleClassName:
      'bg-orange-100/45 hover:bg-orange-100/75 dark:bg-orange-950/25 dark:hover:bg-orange-950/40',
    label: 'Orange',
    markClassName:
      'border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-300',
    selectedClassName:
      'bg-orange-100 shadow-xs ring-1 ring-inset ring-orange-500/80 dark:bg-orange-950/60 dark:ring-orange-400/70',
  },
  pink: {
    accentClassName: 'bg-pink-500',
    groupSurfaceClassName:
      '[&>td]:bg-pink-50/60 hover:[&>td]:bg-pink-50/80 dark:[&>td]:bg-pink-950/20 dark:hover:[&>td]:bg-pink-950/30',
    idleClassName:
      'bg-pink-100/45 hover:bg-pink-100/75 dark:bg-pink-950/25 dark:hover:bg-pink-950/40',
    label: 'Pink',
    markClassName:
      'border-pink-300 bg-pink-50 text-pink-700 dark:border-pink-800 dark:bg-pink-950/40 dark:text-pink-300',
    selectedClassName:
      'bg-pink-100 shadow-xs ring-1 ring-inset ring-pink-500/80 dark:bg-pink-950/60 dark:ring-pink-400/70',
  },
  purple: {
    accentClassName: 'bg-purple-500',
    groupSurfaceClassName:
      '[&>td]:bg-purple-50/60 hover:[&>td]:bg-purple-50/80 dark:[&>td]:bg-purple-950/20 dark:hover:[&>td]:bg-purple-950/30',
    idleClassName:
      'bg-purple-100/45 hover:bg-purple-100/75 dark:bg-purple-950/25 dark:hover:bg-purple-950/40',
    label: 'Purple',
    markClassName:
      'border-purple-300 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-950/40 dark:text-purple-300',
    selectedClassName:
      'bg-purple-100 shadow-xs ring-1 ring-inset ring-purple-500/80 dark:bg-purple-950/60 dark:ring-purple-400/70',
  },
  red: {
    accentClassName: 'bg-red-500',
    groupSurfaceClassName:
      '[&>td]:bg-red-50/60 hover:[&>td]:bg-red-50/80 dark:[&>td]:bg-red-950/20 dark:hover:[&>td]:bg-red-950/30',
    idleClassName: 'bg-red-100/45 hover:bg-red-100/75 dark:bg-red-950/25 dark:hover:bg-red-950/40',
    label: 'Red',
    markClassName:
      'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300',
    selectedClassName:
      'bg-red-100 shadow-xs ring-1 ring-inset ring-red-500/80 dark:bg-red-950/60 dark:ring-red-400/70',
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
  teal: {
    accentClassName: 'bg-teal-500',
    groupSurfaceClassName:
      '[&>td]:bg-teal-50/60 hover:[&>td]:bg-teal-50/80 dark:[&>td]:bg-teal-950/20 dark:hover:[&>td]:bg-teal-950/30',
    idleClassName:
      'bg-teal-100/45 hover:bg-teal-100/75 dark:bg-teal-950/25 dark:hover:bg-teal-950/40',
    label: 'Teal',
    markClassName:
      'border-teal-300 bg-teal-50 text-teal-700 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300',
    selectedClassName:
      'bg-teal-100 shadow-xs ring-1 ring-inset ring-teal-500/80 dark:bg-teal-950/60 dark:ring-teal-400/70',
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
  yellow: {
    accentClassName: 'bg-yellow-500',
    groupSurfaceClassName:
      '[&>td]:bg-yellow-50/60 hover:[&>td]:bg-yellow-50/80 dark:[&>td]:bg-yellow-950/20 dark:hover:[&>td]:bg-yellow-950/30',
    idleClassName:
      'bg-yellow-100/45 hover:bg-yellow-100/75 dark:bg-yellow-950/25 dark:hover:bg-yellow-950/40',
    label: 'Yellow',
    markClassName:
      'border-yellow-300 bg-yellow-50 text-yellow-700 dark:border-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-300',
    selectedClassName:
      'bg-yellow-100 shadow-xs ring-1 ring-inset ring-yellow-500/80 dark:bg-yellow-950/60 dark:ring-yellow-400/70',
  },
  zinc: {
    accentClassName: 'bg-zinc-500',
    groupSurfaceClassName:
      '[&>td]:bg-zinc-50/60 hover:[&>td]:bg-zinc-50/80 dark:[&>td]:bg-zinc-950/20 dark:hover:[&>td]:bg-zinc-950/30',
    idleClassName:
      'bg-zinc-100/45 hover:bg-zinc-100/75 dark:bg-zinc-950/25 dark:hover:bg-zinc-950/40',
    label: 'Zinc',
    markClassName:
      'border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-300',
    selectedClassName:
      'bg-zinc-100 shadow-xs ring-1 ring-inset ring-zinc-500/80 dark:bg-zinc-950/60 dark:ring-zinc-400/70',
  },
} satisfies Record<AssistantThreadColorId, AssistantThreadColorPresentation>;

/** Curated sets keep the expanded picker scannable without changing saved colors. */
export const ASSISTANT_THREAD_COLOR_PALETTES = [
  { colors: ['blue', 'emerald', 'amber', 'rose', 'violet', 'slate'], label: 'Studio' },
  { colors: ['cyan', 'lime', 'orange', 'fuchsia', 'indigo', 'red'], label: 'Voltage' },
  { colors: ['teal', 'green', 'yellow', 'pink', 'purple', 'zinc'], label: 'Afterglow' },
] as const satisfies readonly {
  readonly label: string;
  readonly colors: readonly AssistantThreadColorId[];
}[];

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
