import type { AssistantThreadColorId, AssistantThreadIconId } from '@brainstrike/assistant-data';
import { type AgentColor, getAgentColorStyles } from '@brainstrike/types/agent-color';
import {
  Bug,
  ClipboardList,
  Code2,
  type LucideIcon,
  MessageSquare,
  Rocket,
  Search,
} from 'lucide-react';
import type { CSSProperties } from 'react';

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
  readonly idleClassName: string;
  readonly label: string;
  readonly markClassName: string;
  readonly selectedClassName: string;
}

/**
 * Tabs keep a quiet tint; compact solid marks carry the durable color on the
 * surfaces outside the Threads panel (`getThreadTint` paints the panel).
 * `accentClassName` is the solid swatch used by color pickers.
 */
function solidMark(color: AssistantThreadColorId, fill: string): string {
  const ink = getAgentColorStyles(color)['--agent-ink-light'];
  if (ink === '#000') {
    return `bs-agent-solid-mark ${fill} text-black`;
  }
  if (ink === '#fff') {
    return `bs-agent-solid-mark ${fill} text-white`;
  }
  throw new Error(`Unsupported agent mark ink: ${ink}`);
}

export const ASSISTANT_THREAD_COLOR_PRESENTATION = {
  amber: {
    accentClassName: 'bg-amber-500',
    idleClassName:
      'bg-amber-100/45 hover:bg-amber-100/75 dark:bg-amber-950/25 dark:hover:bg-amber-950/40',
    label: 'Amber',
    markClassName: solidMark('amber', 'bg-amber-500'),
    selectedClassName:
      'bg-amber-100 shadow-xs ring-1 ring-amber-500/80 ring-inset dark:bg-amber-950/60 dark:ring-amber-400/70',
  },
  blue: {
    accentClassName: 'bg-sky-500',
    idleClassName: 'bg-sky-100/45 hover:bg-sky-100/75 dark:bg-sky-950/25 dark:hover:bg-sky-950/40',
    label: 'Blue',
    markClassName: solidMark('blue', 'bg-sky-500'),
    selectedClassName:
      'bg-sky-100 shadow-xs ring-1 ring-inset ring-sky-500/80 dark:bg-sky-950/60 dark:ring-sky-400/70',
  },
  cyan: {
    accentClassName: 'bg-cyan-500',
    idleClassName:
      'bg-cyan-100/45 hover:bg-cyan-100/75 dark:bg-cyan-950/25 dark:hover:bg-cyan-950/40',
    label: 'Cyan',
    markClassName: solidMark('cyan', 'bg-cyan-500'),
    selectedClassName:
      'bg-cyan-100 shadow-xs ring-1 ring-inset ring-cyan-500/80 dark:bg-cyan-950/60 dark:ring-cyan-400/70',
  },
  emerald: {
    accentClassName: 'bg-emerald-500',
    idleClassName:
      'bg-emerald-100/45 hover:bg-emerald-100/75 dark:bg-emerald-950/25 dark:hover:bg-emerald-950/40',
    label: 'Emerald',
    markClassName: solidMark('emerald', 'bg-emerald-500'),
    selectedClassName:
      'bg-emerald-100 shadow-xs ring-1 ring-emerald-500/80 ring-inset dark:bg-emerald-950/60 dark:ring-emerald-400/70',
  },
  fuchsia: {
    accentClassName: 'bg-fuchsia-500',
    idleClassName:
      'bg-fuchsia-100/45 hover:bg-fuchsia-100/75 dark:bg-fuchsia-950/25 dark:hover:bg-fuchsia-950/40',
    label: 'Fuchsia',
    markClassName: solidMark('fuchsia', 'bg-fuchsia-500'),
    selectedClassName:
      'bg-fuchsia-100 shadow-xs ring-1 ring-inset ring-fuchsia-500/80 dark:bg-fuchsia-950/60 dark:ring-fuchsia-400/70',
  },
  green: {
    accentClassName: 'bg-green-500',
    idleClassName:
      'bg-green-100/45 hover:bg-green-100/75 dark:bg-green-950/25 dark:hover:bg-green-950/40',
    label: 'Green',
    markClassName: solidMark('green', 'bg-green-500'),
    selectedClassName:
      'bg-green-100 shadow-xs ring-1 ring-inset ring-green-500/80 dark:bg-green-950/60 dark:ring-green-400/70',
  },
  indigo: {
    accentClassName: 'bg-indigo-500',
    idleClassName:
      'bg-indigo-100/45 hover:bg-indigo-100/75 dark:bg-indigo-950/25 dark:hover:bg-indigo-950/40',
    label: 'Indigo',
    markClassName: solidMark('indigo', 'bg-indigo-500'),
    selectedClassName:
      'bg-indigo-100 shadow-xs ring-1 ring-inset ring-indigo-500/80 dark:bg-indigo-950/60 dark:ring-indigo-400/70',
  },
  lime: {
    accentClassName: 'bg-lime-500',
    idleClassName:
      'bg-lime-100/45 hover:bg-lime-100/75 dark:bg-lime-950/25 dark:hover:bg-lime-950/40',
    label: 'Lime',
    markClassName: solidMark('lime', 'bg-lime-500'),
    selectedClassName:
      'bg-lime-100 shadow-xs ring-1 ring-inset ring-lime-500/80 dark:bg-lime-950/60 dark:ring-lime-400/70',
  },
  orange: {
    accentClassName: 'bg-orange-500',
    idleClassName:
      'bg-orange-100/45 hover:bg-orange-100/75 dark:bg-orange-950/25 dark:hover:bg-orange-950/40',
    label: 'Orange',
    markClassName: solidMark('orange', 'bg-orange-500'),
    selectedClassName:
      'bg-orange-100 shadow-xs ring-1 ring-inset ring-orange-500/80 dark:bg-orange-950/60 dark:ring-orange-400/70',
  },
  pink: {
    accentClassName: 'bg-pink-500',
    idleClassName:
      'bg-pink-100/45 hover:bg-pink-100/75 dark:bg-pink-950/25 dark:hover:bg-pink-950/40',
    label: 'Pink',
    markClassName: solidMark('pink', 'bg-pink-500'),
    selectedClassName:
      'bg-pink-100 shadow-xs ring-1 ring-inset ring-pink-500/80 dark:bg-pink-950/60 dark:ring-pink-400/70',
  },
  purple: {
    accentClassName: 'bg-purple-500',
    idleClassName:
      'bg-purple-100/45 hover:bg-purple-100/75 dark:bg-purple-950/25 dark:hover:bg-purple-950/40',
    label: 'Purple',
    markClassName: solidMark('purple', 'bg-purple-500'),
    selectedClassName:
      'bg-purple-100 shadow-xs ring-1 ring-inset ring-purple-500/80 dark:bg-purple-950/60 dark:ring-purple-400/70',
  },
  red: {
    accentClassName: 'bg-red-500',
    idleClassName: 'bg-red-100/45 hover:bg-red-100/75 dark:bg-red-950/25 dark:hover:bg-red-950/40',
    label: 'Red',
    markClassName: solidMark('red', 'bg-red-500'),
    selectedClassName:
      'bg-red-100 shadow-xs ring-1 ring-inset ring-red-500/80 dark:bg-red-950/60 dark:ring-red-400/70',
  },
  rose: {
    accentClassName: 'bg-rose-500',
    idleClassName:
      'bg-rose-100/45 hover:bg-rose-100/75 dark:bg-rose-950/25 dark:hover:bg-rose-950/40',
    label: 'Rose',
    markClassName: solidMark('rose', 'bg-rose-500'),
    selectedClassName:
      'bg-rose-100 shadow-xs ring-1 ring-inset ring-rose-500/80 dark:bg-rose-950/60 dark:ring-rose-400/70',
  },
  slate: {
    accentClassName: 'bg-slate-500',
    idleClassName:
      'bg-slate-100/55 hover:bg-slate-100/85 dark:bg-slate-900/30 dark:hover:bg-slate-900/45',
    label: 'Slate',
    markClassName: solidMark('slate', 'bg-slate-500'),
    selectedClassName:
      'bg-slate-200/80 shadow-xs ring-1 ring-inset ring-slate-500/80 dark:bg-slate-900/70 dark:ring-slate-400/70',
  },
  teal: {
    accentClassName: 'bg-teal-500',
    idleClassName:
      'bg-teal-100/45 hover:bg-teal-100/75 dark:bg-teal-950/25 dark:hover:bg-teal-950/40',
    label: 'Teal',
    markClassName: solidMark('teal', 'bg-teal-500'),
    selectedClassName:
      'bg-teal-100 shadow-xs ring-1 ring-inset ring-teal-500/80 dark:bg-teal-950/60 dark:ring-teal-400/70',
  },
  violet: {
    accentClassName: 'bg-violet-500',
    idleClassName:
      'bg-violet-100/45 hover:bg-violet-100/75 dark:bg-violet-950/25 dark:hover:bg-violet-950/40',
    label: 'Violet',
    markClassName: solidMark('violet', 'bg-violet-500'),
    selectedClassName:
      'bg-violet-100 shadow-xs ring-1 ring-inset ring-violet-500/80 dark:bg-violet-950/60 dark:ring-violet-400/70',
  },
  yellow: {
    accentClassName: 'bg-yellow-500',
    idleClassName:
      'bg-yellow-100/45 hover:bg-yellow-100/75 dark:bg-yellow-950/25 dark:hover:bg-yellow-950/40',
    label: 'Yellow',
    markClassName: solidMark('yellow', 'bg-yellow-500'),
    selectedClassName:
      'bg-yellow-100 shadow-xs ring-1 ring-inset ring-yellow-500/80 dark:bg-yellow-950/60 dark:ring-yellow-400/70',
  },
  zinc: {
    accentClassName: 'bg-zinc-500',
    idleClassName:
      'bg-zinc-100/45 hover:bg-zinc-100/75 dark:bg-zinc-950/25 dark:hover:bg-zinc-950/40',
    label: 'Zinc',
    markClassName: solidMark('zinc', 'bg-zinc-500'),
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
export const THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME = 'min-h-7';
/** Control height plus the 2px vertical margin on each side of a panel row. */
export const THREAD_CONTROL_ROW_PITCH_PX = THREAD_CONTROL_HEIGHT_PX + 4;
export const THREAD_CONTROL_TITLE_CLASS_NAME = 'min-w-0 truncate font-medium text-xs leading-4';
/**
 * The identity chip every Threads-panel row leads with — section, thread and
 * child alike — and the thread tabs reuse. 20px in a 28px row leaves 4px above
 * and below; rows pad 4px at the leading edge so the chip is inset evenly.
 *
 * `size-5` rather than `h-5 w-5`: shared button base rules guard on
 * `:not([class*=size-])`, so the paired utilities lose to a 16px base rule.
 */
export const THREAD_CONTROL_MARK_CLASS_NAME =
  'flex size-5 shrink-0 items-center justify-center rounded-md';

/**
 * How a coloured identity paints in the Threads panel: the soft mark and the
 * leading-edge wash in `globals.css`, from the one CSS variable pair that
 * `getAgentColorStyles` sets. A thread's own colour and a child's family colour
 * go through it alike. No colour paints nothing: the row stays the explorer's
 * plain row and the glyph its muted icon.
 */
export function getThreadTint(color: AgentColor | null | undefined): {
  readonly markClassName: string;
  readonly style: CSSProperties | undefined;
  readonly washClassName: string;
} {
  if (!color) {
    return { markClassName: 'text-muted-foreground', style: undefined, washClassName: '' };
  }
  return {
    markClassName: 'bs-thread-tint bs-thread-mark',
    style: getAgentColorStyles(color) as CSSProperties,
    washClassName: 'bs-thread-tint bs-thread-wash',
  };
}

/**
 * The row surface every Threads-panel row shares, as the explorer's rows share
 * theirs: no fill at rest, the accent fill on hover and selection, a focus ring
 * drawn inside the row. 4px at the leading and trailing edges matches the 4px
 * the 20px chip leaves above and below it in the 28px row.
 */
export const THREAD_PANEL_ROW_CLASS_NAME =
  'my-0.5 flex min-h-7 min-w-0 rounded-md px-1 transition-colors hover:bg-accent/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-inset data-[selected=true]:bg-accent motion-reduce:transition-none';

/**
 * Secondary affordances that sit *inside* a thread row — its expand and
 * actions buttons. (Thread tabs use the shared TabStrip's close button.)
 *
 * 20px, not the Button `icon-xs` 28px: the control itself is 28px tall now, so
 * a 28px chip fills it edge to edge and the hover fill reads as a block rather
 * than a button. 20px leaves 4px above and below. The `after` inset restores a
 * 28px pointer target, keeping it above the 24px guidance.
 *
 * `hover:bg-foreground/10` rather than `bg-muted`/`bg-accent`: these sit on
 * the row's accent fill or its colour wash, and an opaque neutral fill would
 * paint a grey blotch into either.
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

/** The row control and its status glyph announce the same thread identity. */
export function getThreadRowAccessibleName(
  state: ThreadRowStatusState | null,
  title: string
): string {
  switch (state) {
    case 'running':
      return `${title} is active`;
    case 'needs-you':
      return `${title} needs your approval`;
    case 'failed-unseen':
      return `${title} failed`;
    case 'done-unseen':
      return `${title} has unseen activity`;
    default:
      return title;
  }
}

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
