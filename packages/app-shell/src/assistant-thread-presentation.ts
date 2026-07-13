import type { AssistantThreadColorId } from './assistant-memory-repository';

export interface AssistantThreadColorPresentation {
  readonly accentClassName: string;
  readonly iconClassName: string;
  readonly label: string;
}

export const ASSISTANT_THREAD_COLOR_PRESENTATION = {
  amber: {
    accentClassName: 'bg-amber-500',
    iconClassName:
      'bg-amber-50 text-amber-700 ring-amber-200/80 dark:bg-amber-950/55 dark:text-amber-300 dark:ring-amber-800/80',
    label: 'Amber',
  },
  blue: {
    accentClassName: 'bg-sky-500',
    iconClassName:
      'bg-sky-50 text-sky-700 ring-sky-200/80 dark:bg-sky-950/55 dark:text-sky-300 dark:ring-sky-800/80',
    label: 'Blue',
  },
  emerald: {
    accentClassName: 'bg-emerald-500',
    iconClassName:
      'bg-emerald-50 text-emerald-700 ring-emerald-200/80 dark:bg-emerald-950/55 dark:text-emerald-300 dark:ring-emerald-800/80',
    label: 'Emerald',
  },
  rose: {
    accentClassName: 'bg-rose-500',
    iconClassName:
      'bg-rose-50 text-rose-700 ring-rose-200/80 dark:bg-rose-950/55 dark:text-rose-300 dark:ring-rose-800/80',
    label: 'Rose',
  },
  slate: {
    accentClassName: 'bg-slate-500',
    iconClassName:
      'bg-slate-100 text-slate-700 ring-slate-300/80 dark:bg-slate-900/70 dark:text-slate-300 dark:ring-slate-700/80',
    label: 'Slate',
  },
  violet: {
    accentClassName: 'bg-violet-500',
    iconClassName:
      'bg-violet-50 text-violet-700 ring-violet-200/80 dark:bg-violet-950/55 dark:text-violet-300 dark:ring-violet-800/80',
    label: 'Violet',
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
