import type { AssistantThreadColorId } from './assistant-memory-repository';

export interface AssistantThreadColorPresentation {
  readonly accentClassName: string;
  readonly iconClassName: string;
  readonly label: string;
  readonly markClassName: string;
  readonly selectedClassName: string;
}

export const ASSISTANT_THREAD_COLOR_PRESENTATION = {
  amber: {
    accentClassName: 'bg-amber-500',
    iconClassName:
      'bg-amber-50 text-amber-700 ring-amber-200/80 dark:bg-amber-950/55 dark:text-amber-300 dark:ring-amber-800/80',
    label: 'Amber',
    markClassName:
      'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
    selectedClassName: 'border-amber-300 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/20',
  },
  blue: {
    accentClassName: 'bg-sky-500',
    iconClassName:
      'bg-sky-50 text-sky-700 ring-sky-200/80 dark:bg-sky-950/55 dark:text-sky-300 dark:ring-sky-800/80',
    label: 'Blue',
    markClassName:
      'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300',
    selectedClassName: 'border-sky-300 bg-sky-50/70 dark:border-sky-800 dark:bg-sky-950/20',
  },
  emerald: {
    accentClassName: 'bg-emerald-500',
    iconClassName:
      'bg-emerald-50 text-emerald-700 ring-emerald-200/80 dark:bg-emerald-950/55 dark:text-emerald-300 dark:ring-emerald-800/80',
    label: 'Emerald',
    markClassName:
      'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
    selectedClassName:
      'border-emerald-300 bg-emerald-50/70 dark:border-emerald-800 dark:bg-emerald-950/20',
  },
  rose: {
    accentClassName: 'bg-rose-500',
    iconClassName:
      'bg-rose-50 text-rose-700 ring-rose-200/80 dark:bg-rose-950/55 dark:text-rose-300 dark:ring-rose-800/80',
    label: 'Rose',
    markClassName:
      'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300',
    selectedClassName: 'border-rose-300 bg-rose-50/70 dark:border-rose-800 dark:bg-rose-950/20',
  },
  slate: {
    accentClassName: 'bg-slate-500',
    iconClassName:
      'bg-slate-100 text-slate-700 ring-slate-300/80 dark:bg-slate-900/70 dark:text-slate-300 dark:ring-slate-700/80',
    label: 'Slate',
    markClassName:
      'border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-300',
    selectedClassName: 'border-slate-300 bg-slate-50/70 dark:border-slate-700 dark:bg-slate-900/30',
  },
  violet: {
    accentClassName: 'bg-violet-500',
    iconClassName:
      'bg-violet-50 text-violet-700 ring-violet-200/80 dark:bg-violet-950/55 dark:text-violet-300 dark:ring-violet-800/80',
    label: 'Violet',
    markClassName:
      'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300',
    selectedClassName:
      'border-violet-300 bg-violet-50/70 dark:border-violet-800 dark:bg-violet-950/20',
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
