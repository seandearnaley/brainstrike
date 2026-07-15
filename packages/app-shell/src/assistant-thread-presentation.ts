import type { AssistantThreadColorId } from './assistant-memory-repository';

export interface AssistantThreadColorPresentation {
  readonly accentClassName: string;
  readonly iconClassName: string;
  readonly idleClassName: string;
  readonly label: string;
  readonly markClassName: string;
  readonly selectedClassName: string;
}

export const ASSISTANT_THREAD_COLOR_PRESENTATION = {
  amber: {
    accentClassName: 'bg-amber-500',
    iconClassName:
      'bg-amber-50 text-amber-700 ring-amber-200/80 dark:bg-amber-950/55 dark:text-amber-300 dark:ring-amber-800/80',
    idleClassName:
      'bg-amber-50/20 ring-amber-200/30 hover:bg-amber-50/35 hover:ring-amber-300/50 dark:bg-amber-950/10 dark:ring-amber-800/35 dark:hover:bg-amber-950/25',
    label: 'Amber',
    markClassName:
      'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
    selectedClassName:
      'bg-amber-50/80 ring-2 ring-amber-400/70 shadow-sm dark:bg-amber-950/35 dark:ring-amber-700',
  },
  blue: {
    accentClassName: 'bg-sky-500',
    iconClassName:
      'bg-sky-50 text-sky-700 ring-sky-200/80 dark:bg-sky-950/55 dark:text-sky-300 dark:ring-sky-800/80',
    idleClassName:
      'bg-sky-50/20 ring-sky-200/30 hover:bg-sky-50/35 hover:ring-sky-300/50 dark:bg-sky-950/10 dark:ring-sky-800/35 dark:hover:bg-sky-950/25',
    label: 'Blue',
    markClassName:
      'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300',
    selectedClassName:
      'bg-sky-50/80 ring-2 ring-sky-400/70 shadow-sm dark:bg-sky-950/35 dark:ring-sky-700',
  },
  emerald: {
    accentClassName: 'bg-emerald-500',
    iconClassName:
      'bg-emerald-50 text-emerald-700 ring-emerald-200/80 dark:bg-emerald-950/55 dark:text-emerald-300 dark:ring-emerald-800/80',
    idleClassName:
      'bg-emerald-50/20 ring-emerald-200/30 hover:bg-emerald-50/35 hover:ring-emerald-300/50 dark:bg-emerald-950/10 dark:ring-emerald-800/35 dark:hover:bg-emerald-950/25',
    label: 'Emerald',
    markClassName:
      'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
    selectedClassName:
      'bg-emerald-50/80 ring-2 ring-emerald-400/70 shadow-sm dark:bg-emerald-950/35 dark:ring-emerald-700',
  },
  rose: {
    accentClassName: 'bg-rose-500',
    iconClassName:
      'bg-rose-50 text-rose-700 ring-rose-200/80 dark:bg-rose-950/55 dark:text-rose-300 dark:ring-rose-800/80',
    idleClassName:
      'bg-rose-50/20 ring-rose-200/30 hover:bg-rose-50/35 hover:ring-rose-300/50 dark:bg-rose-950/10 dark:ring-rose-800/35 dark:hover:bg-rose-950/25',
    label: 'Rose',
    markClassName:
      'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300',
    selectedClassName:
      'bg-rose-50/80 ring-2 ring-rose-400/70 shadow-sm dark:bg-rose-950/35 dark:ring-rose-700',
  },
  slate: {
    accentClassName: 'bg-slate-500',
    iconClassName:
      'bg-slate-100 text-slate-700 ring-slate-300/80 dark:bg-slate-900/70 dark:text-slate-300 dark:ring-slate-700/80',
    idleClassName:
      'bg-slate-50/25 ring-slate-200/35 hover:bg-slate-100/45 hover:ring-slate-300/55 dark:bg-slate-900/15 dark:ring-slate-700/40 dark:hover:bg-slate-900/30',
    label: 'Slate',
    markClassName:
      'border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-300',
    selectedClassName:
      'bg-slate-100/85 ring-2 ring-slate-400/70 shadow-sm dark:bg-slate-900/50 dark:ring-slate-600',
  },
  violet: {
    accentClassName: 'bg-violet-500',
    iconClassName:
      'bg-violet-50 text-violet-700 ring-violet-200/80 dark:bg-violet-950/55 dark:text-violet-300 dark:ring-violet-800/80',
    idleClassName:
      'bg-violet-50/20 ring-violet-200/30 hover:bg-violet-50/35 hover:ring-violet-300/50 dark:bg-violet-950/10 dark:ring-violet-800/35 dark:hover:bg-violet-950/25',
    label: 'Violet',
    markClassName:
      'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300',
    selectedClassName:
      'bg-violet-50/80 ring-2 ring-violet-400/70 shadow-sm dark:bg-violet-950/35 dark:ring-violet-700',
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
