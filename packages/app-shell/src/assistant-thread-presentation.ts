import type { AssistantThreadColorId } from './assistant-memory-repository';

export interface AssistantThreadColorPresentation {
  readonly accentClassName: string;
  readonly iconClassName: string;
  readonly idleClassName: string;
  readonly label: string;
  readonly markClassName: string;
  readonly railClassName: string;
  readonly railEndClassName: string;
  readonly railStartClassName: string;
  readonly selectedClassName: string;
}

export const ASSISTANT_THREAD_COLOR_PRESENTATION = {
  amber: {
    accentClassName: 'bg-amber-500',
    iconClassName:
      'bg-amber-50 text-amber-700 ring-amber-200/80 dark:bg-amber-950/55 dark:text-amber-300 dark:ring-amber-800/80',
    idleClassName:
      'bg-amber-50/50 ring-amber-200/70 hover:bg-amber-50/80 hover:ring-amber-300/80 dark:bg-amber-950/25 dark:ring-amber-800/60 dark:hover:bg-amber-950/40',
    label: 'Amber',
    markClassName:
      'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
    railClassName:
      'border-l-4 border-l-amber-500 bg-amber-50/25 hover:bg-amber-50/40 dark:bg-amber-950/10 dark:hover:bg-amber-950/20 [&>td:first-child]:shadow-[inset_44px_0_0_rgb(245_158_11_/_0.14)]',
    railEndClassName:
      '[&>td:first-child]:rounded-b-lg [&>td:first-child]:border-b-2 [&>td:first-child]:border-b-amber-500/40',
    railStartClassName:
      '[&>td:first-child]:rounded-t-lg [&>td:first-child]:border-t-2 [&>td:first-child]:border-t-amber-500',
    selectedClassName: 'bg-amber-50/70 ring-amber-300 dark:bg-amber-950/20 dark:ring-amber-800',
  },
  blue: {
    accentClassName: 'bg-sky-500',
    iconClassName:
      'bg-sky-50 text-sky-700 ring-sky-200/80 dark:bg-sky-950/55 dark:text-sky-300 dark:ring-sky-800/80',
    idleClassName:
      'bg-sky-50/50 ring-sky-200/70 hover:bg-sky-50/80 hover:ring-sky-300/80 dark:bg-sky-950/25 dark:ring-sky-800/60 dark:hover:bg-sky-950/40',
    label: 'Blue',
    markClassName:
      'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300',
    railClassName:
      'border-l-4 border-l-sky-500 bg-sky-50/25 hover:bg-sky-50/40 dark:bg-sky-950/10 dark:hover:bg-sky-950/20 [&>td:first-child]:shadow-[inset_44px_0_0_rgb(14_165_233_/_0.14)]',
    railEndClassName:
      '[&>td:first-child]:rounded-b-lg [&>td:first-child]:border-b-2 [&>td:first-child]:border-b-sky-500/40',
    railStartClassName:
      '[&>td:first-child]:rounded-t-lg [&>td:first-child]:border-t-2 [&>td:first-child]:border-t-sky-500',
    selectedClassName: 'bg-sky-50/70 ring-sky-300 dark:bg-sky-950/20 dark:ring-sky-800',
  },
  emerald: {
    accentClassName: 'bg-emerald-500',
    iconClassName:
      'bg-emerald-50 text-emerald-700 ring-emerald-200/80 dark:bg-emerald-950/55 dark:text-emerald-300 dark:ring-emerald-800/80',
    idleClassName:
      'bg-emerald-50/50 ring-emerald-200/70 hover:bg-emerald-50/80 hover:ring-emerald-300/80 dark:bg-emerald-950/25 dark:ring-emerald-800/60 dark:hover:bg-emerald-950/40',
    label: 'Emerald',
    markClassName:
      'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
    railClassName:
      'border-l-4 border-l-emerald-500 bg-emerald-50/25 hover:bg-emerald-50/40 dark:bg-emerald-950/10 dark:hover:bg-emerald-950/20 [&>td:first-child]:shadow-[inset_44px_0_0_rgb(16_185_129_/_0.14)]',
    railEndClassName:
      '[&>td:first-child]:rounded-b-lg [&>td:first-child]:border-b-2 [&>td:first-child]:border-b-emerald-500/40',
    railStartClassName:
      '[&>td:first-child]:rounded-t-lg [&>td:first-child]:border-t-2 [&>td:first-child]:border-t-emerald-500',
    selectedClassName:
      'bg-emerald-50/70 ring-emerald-300 dark:bg-emerald-950/20 dark:ring-emerald-800',
  },
  rose: {
    accentClassName: 'bg-rose-500',
    iconClassName:
      'bg-rose-50 text-rose-700 ring-rose-200/80 dark:bg-rose-950/55 dark:text-rose-300 dark:ring-rose-800/80',
    idleClassName:
      'bg-rose-50/50 ring-rose-200/70 hover:bg-rose-50/80 hover:ring-rose-300/80 dark:bg-rose-950/25 dark:ring-rose-800/60 dark:hover:bg-rose-950/40',
    label: 'Rose',
    markClassName:
      'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300',
    railClassName:
      'border-l-4 border-l-rose-500 bg-rose-50/25 hover:bg-rose-50/40 dark:bg-rose-950/10 dark:hover:bg-rose-950/20 [&>td:first-child]:shadow-[inset_44px_0_0_rgb(244_63_94_/_0.14)]',
    railEndClassName:
      '[&>td:first-child]:rounded-b-lg [&>td:first-child]:border-b-2 [&>td:first-child]:border-b-rose-500/40',
    railStartClassName:
      '[&>td:first-child]:rounded-t-lg [&>td:first-child]:border-t-2 [&>td:first-child]:border-t-rose-500',
    selectedClassName: 'bg-rose-50/70 ring-rose-300 dark:bg-rose-950/20 dark:ring-rose-800',
  },
  slate: {
    accentClassName: 'bg-slate-500',
    iconClassName:
      'bg-slate-100 text-slate-700 ring-slate-300/80 dark:bg-slate-900/70 dark:text-slate-300 dark:ring-slate-700/80',
    idleClassName:
      'bg-slate-50/60 ring-slate-200/80 hover:bg-slate-100/80 hover:ring-slate-300/80 dark:bg-slate-900/35 dark:ring-slate-700/70 dark:hover:bg-slate-900/55',
    label: 'Slate',
    markClassName:
      'border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-300',
    railClassName:
      'border-l-4 border-l-slate-500 bg-slate-50/40 hover:bg-slate-100/55 dark:bg-slate-900/20 dark:hover:bg-slate-900/35 [&>td:first-child]:shadow-[inset_44px_0_0_rgb(100_116_139_/_0.16)]',
    railEndClassName:
      '[&>td:first-child]:rounded-b-lg [&>td:first-child]:border-b-2 [&>td:first-child]:border-b-slate-500/40',
    railStartClassName:
      '[&>td:first-child]:rounded-t-lg [&>td:first-child]:border-t-2 [&>td:first-child]:border-t-slate-500',
    selectedClassName: 'bg-slate-50/70 ring-slate-300 dark:bg-slate-900/30 dark:ring-slate-700',
  },
  violet: {
    accentClassName: 'bg-violet-500',
    iconClassName:
      'bg-violet-50 text-violet-700 ring-violet-200/80 dark:bg-violet-950/55 dark:text-violet-300 dark:ring-violet-800/80',
    idleClassName:
      'bg-violet-50/50 ring-violet-200/70 hover:bg-violet-50/80 hover:ring-violet-300/80 dark:bg-violet-950/25 dark:ring-violet-800/60 dark:hover:bg-violet-950/40',
    label: 'Violet',
    markClassName:
      'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300',
    railClassName:
      'border-l-4 border-l-violet-500 bg-violet-50/25 hover:bg-violet-50/40 dark:bg-violet-950/10 dark:hover:bg-violet-950/20 [&>td:first-child]:shadow-[inset_44px_0_0_rgb(139_92_246_/_0.14)]',
    railEndClassName:
      '[&>td:first-child]:rounded-b-lg [&>td:first-child]:border-b-2 [&>td:first-child]:border-b-violet-500/40',
    railStartClassName:
      '[&>td:first-child]:rounded-t-lg [&>td:first-child]:border-t-2 [&>td:first-child]:border-t-violet-500',
    selectedClassName: 'bg-violet-50/70 ring-violet-300 dark:bg-violet-950/20 dark:ring-violet-800',
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
