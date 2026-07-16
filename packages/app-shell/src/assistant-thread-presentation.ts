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

export const ASSISTANT_THREAD_COLOR_PRESENTATION = {
  amber: {
    accentClassName: 'bg-amber-500',
    groupSurfaceClassName:
      '[&>td]:border-amber-200/60 [&>td]:bg-amber-50/60 hover:[&>td]:bg-amber-50/80 dark:[&>td]:border-amber-800/50 dark:[&>td]:bg-amber-950/20 dark:hover:[&>td]:bg-amber-950/30',
    iconClassName:
      'bg-amber-50 text-amber-700 ring-amber-200/80 dark:bg-amber-950/55 dark:text-amber-300 dark:ring-amber-800/80',
    idleClassName:
      'border-amber-200/20 bg-transparent hover:border-amber-300/45 hover:bg-amber-50/25 dark:border-amber-800/25 dark:hover:bg-amber-950/20',
    label: 'Amber',
    markClassName:
      'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
    selectedClassName:
      'border-amber-500 bg-amber-100/90 shadow-sm dark:border-amber-500 dark:bg-amber-950/55',
  },
  blue: {
    accentClassName: 'bg-sky-500',
    groupSurfaceClassName:
      '[&>td]:border-sky-200/60 [&>td]:bg-sky-50/60 hover:[&>td]:bg-sky-50/80 dark:[&>td]:border-sky-800/50 dark:[&>td]:bg-sky-950/20 dark:hover:[&>td]:bg-sky-950/30',
    iconClassName:
      'bg-sky-50 text-sky-700 ring-sky-200/80 dark:bg-sky-950/55 dark:text-sky-300 dark:ring-sky-800/80',
    idleClassName:
      'border-sky-200/20 bg-transparent hover:border-sky-300/45 hover:bg-sky-50/25 dark:border-sky-800/25 dark:hover:bg-sky-950/20',
    label: 'Blue',
    markClassName:
      'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300',
    selectedClassName:
      'border-sky-500 bg-sky-100/90 shadow-sm dark:border-sky-500 dark:bg-sky-950/55',
  },
  emerald: {
    accentClassName: 'bg-emerald-500',
    groupSurfaceClassName:
      '[&>td]:border-emerald-200/60 [&>td]:bg-emerald-50/60 hover:[&>td]:bg-emerald-50/80 dark:[&>td]:border-emerald-800/50 dark:[&>td]:bg-emerald-950/20 dark:hover:[&>td]:bg-emerald-950/30',
    iconClassName:
      'bg-emerald-50 text-emerald-700 ring-emerald-200/80 dark:bg-emerald-950/55 dark:text-emerald-300 dark:ring-emerald-800/80',
    idleClassName:
      'border-emerald-200/20 bg-transparent hover:border-emerald-300/45 hover:bg-emerald-50/25 dark:border-emerald-800/25 dark:hover:bg-emerald-950/20',
    label: 'Emerald',
    markClassName:
      'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
    selectedClassName:
      'border-emerald-500 bg-emerald-100/90 shadow-sm dark:border-emerald-500 dark:bg-emerald-950/55',
  },
  rose: {
    accentClassName: 'bg-rose-500',
    groupSurfaceClassName:
      '[&>td]:border-rose-200/60 [&>td]:bg-rose-50/60 hover:[&>td]:bg-rose-50/80 dark:[&>td]:border-rose-800/50 dark:[&>td]:bg-rose-950/20 dark:hover:[&>td]:bg-rose-950/30',
    iconClassName:
      'bg-rose-50 text-rose-700 ring-rose-200/80 dark:bg-rose-950/55 dark:text-rose-300 dark:ring-rose-800/80',
    idleClassName:
      'border-rose-200/20 bg-transparent hover:border-rose-300/45 hover:bg-rose-50/25 dark:border-rose-800/25 dark:hover:bg-rose-950/20',
    label: 'Rose',
    markClassName:
      'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300',
    selectedClassName:
      'border-rose-500 bg-rose-100/90 shadow-sm dark:border-rose-500 dark:bg-rose-950/55',
  },
  slate: {
    accentClassName: 'bg-slate-500',
    groupSurfaceClassName:
      '[&>td]:border-slate-200/60 [&>td]:bg-slate-100/55 hover:[&>td]:bg-slate-100/75 dark:[&>td]:border-slate-700/55 dark:[&>td]:bg-slate-900/25 dark:hover:[&>td]:bg-slate-900/35',
    iconClassName:
      'bg-slate-100 text-slate-700 ring-slate-300/80 dark:bg-slate-900/70 dark:text-slate-300 dark:ring-slate-700/80',
    idleClassName:
      'border-slate-200/20 bg-transparent hover:border-slate-300/45 hover:bg-slate-100/30 dark:border-slate-700/30 dark:hover:bg-slate-900/25',
    label: 'Slate',
    markClassName:
      'border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-300',
    selectedClassName:
      'border-slate-500 bg-slate-200/90 shadow-sm dark:border-slate-500 dark:bg-slate-900/70',
  },
  violet: {
    accentClassName: 'bg-violet-500',
    groupSurfaceClassName:
      '[&>td]:border-violet-200/60 [&>td]:bg-violet-50/60 hover:[&>td]:bg-violet-50/80 dark:[&>td]:border-violet-800/50 dark:[&>td]:bg-violet-950/20 dark:hover:[&>td]:bg-violet-950/30',
    iconClassName:
      'bg-violet-50 text-violet-700 ring-violet-200/80 dark:bg-violet-950/55 dark:text-violet-300 dark:ring-violet-800/80',
    idleClassName:
      'border-violet-200/20 bg-transparent hover:border-violet-300/45 hover:bg-violet-50/25 dark:border-violet-800/25 dark:hover:bg-violet-950/20',
    label: 'Violet',
    markClassName:
      'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300',
    selectedClassName:
      'border-violet-500 bg-violet-100/90 shadow-sm dark:border-violet-500 dark:bg-violet-950/55',
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
