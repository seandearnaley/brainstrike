import type { AssistantThreadColorId } from './assistant-memory-repository';

export interface AssistantThreadColorPresentation {
  readonly accentClassName: string;
  readonly groupSurfaceClassName: string;
  readonly iconClassName: string;
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
    iconClassName:
      'bg-amber-100 text-amber-700 ring-amber-300/70 dark:bg-amber-950/60 dark:text-amber-300 dark:ring-amber-700/70',
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
    iconClassName:
      'bg-sky-100 text-sky-700 ring-sky-300/70 dark:bg-sky-950/60 dark:text-sky-300 dark:ring-sky-700/70',
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
    iconClassName:
      'bg-emerald-100 text-emerald-700 ring-emerald-300/70 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-700/70',
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
    iconClassName:
      'bg-rose-100 text-rose-700 ring-rose-300/70 dark:bg-rose-950/60 dark:text-rose-300 dark:ring-rose-700/70',
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
    iconClassName:
      'bg-slate-100 text-slate-700 ring-slate-300/80 dark:bg-slate-900/70 dark:text-slate-300 dark:ring-slate-600/70',
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
    iconClassName:
      'bg-violet-100 text-violet-700 ring-violet-300/70 dark:bg-violet-950/60 dark:text-violet-300 dark:ring-violet-700/70',
    idleClassName:
      'bg-violet-100/45 hover:bg-violet-100/75 dark:bg-violet-950/25 dark:hover:bg-violet-950/40',
    label: 'Violet',
    markClassName:
      'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300',
    selectedClassName:
      'bg-violet-100 shadow-xs ring-1 ring-inset ring-violet-500/80 dark:bg-violet-950/60 dark:ring-violet-400/70',
  },
} satisfies Record<AssistantThreadColorId, AssistantThreadColorPresentation>;

export function getAssistantThreadColorPresentation(
  colorId: AssistantThreadColorId | undefined
): AssistantThreadColorPresentation | null {
  if (!colorId) {
    return null;
  }
  return ASSISTANT_THREAD_COLOR_PRESENTATION[colorId];
}
