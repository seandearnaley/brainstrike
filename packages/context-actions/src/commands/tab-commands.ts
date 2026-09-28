import { adjacentTabId, type TabCycleDirection } from '../tab-strip-actions.js';
import type { ActionOutcome } from '../types.js';
import type { Command, RunCommand } from './types.js';

export interface TabCommandTab {
  /** Tells same-label tabs apart (a file's relative path, a page's URL). */
  readonly detail?: string;
  readonly id: string;
  readonly label: string;
}

/**
 * The focus-scoped tab strip the tab commands act on (BST-1842): the strip
 * whose panel held focus when the palette opened. Consumers register these
 * operations; this package holds no tab state.
 */
export interface TabCommandStrip {
  /** Settles once the tab is active; rejects when activation failed. */
  readonly activate: (id: string) => Promise<void>;
  /** Settles once the tab has closed (a browser tab: in main); rejects on failure. */
  readonly close: (id: string) => Promise<void>;
  readonly getActiveId: () => string | null;
  /** Every tab in strip order. */
  readonly getTabs: () => readonly TabCommandTab[];
  /** Whether the strip's closed-tab history has an entry to reopen. */
  readonly hasClosedTabs: () => boolean;
  readonly reopenClosed: () => Promise<ActionOutcome>;
}

const OK: ActionOutcome = { ok: true };

/** Activate the tab beside the active one, by position, wrapping (D7). */
export function cycleTab(strip: TabCommandStrip, direction: TabCycleDirection): Promise<void> {
  const ids = strip.getTabs().map((tab) => tab.id);
  const target = adjacentTabId(ids, strip.getActiveId(), direction);
  return target === null ? Promise.resolve() : strip.activate(target);
}

function toFailure(error: unknown): ActionOutcome {
  return { error: error instanceof Error ? error.message : String(error), ok: false };
}

/**
 * Run a strip operation that reports its own outcome, to a settled one. It runs
 * synchronously, so a store mutation has happened on return (and a file
 * permission prompt still has its user gesture); a synchronous throw and a
 * rejection both become a failed outcome, never an escaped error.
 */
export function settleTabOutcome(
  operation: () => ActionOutcome | Promise<ActionOutcome>
): Promise<ActionOutcome> {
  try {
    return Promise.resolve(operation()).then((outcome) => outcome, toFailure);
  } catch (error: unknown) {
    return Promise.resolve(toFailure(error));
  }
}

/** `settleTabOutcome` for an operation that only settles: success is `{ ok: true }`. */
export function settleTabOperation(operation: () => unknown): Promise<ActionOutcome> {
  return settleTabOutcome(() => Promise.resolve(operation()).then((): ActionOutcome => OK));
}

/**
 * Close Tab, Reopen Closed Tab, Next Tab, Previous Tab and Go to Tab…. The
 * strip is read when a command is listed and when it runs, never cached: with
 * no strip in scope every command is hidden, not a stub.
 */
export function createTabCommands(getStrip: () => TabCommandStrip | undefined): readonly Command[] {
  const isAvailable = (): boolean => getStrip() !== undefined;
  const withStrip = (run: (strip: TabCommandStrip) => Promise<ActionOutcome>) => () => {
    const strip = getStrip();
    return strip ? settleTabOutcome(() => run(strip)) : Promise.resolve<ActionOutcome>(NO_STRIP);
  };
  const cycle = (direction: TabCycleDirection): RunCommand['run'] =>
    withStrip((strip) => settleTabOperation(() => cycleTab(strip, direction)));

  return [
    {
      group: 'navigate',
      id: 'tab.close',
      isAvailable,
      keywords: ['tab'],
      label: 'Close Tab',
      run: withStrip((strip) => {
        const activeId = strip.getActiveId();
        if (activeId === null) {
          return Promise.resolve<ActionOutcome>({ error: 'No tab is open', ok: false });
        }
        return settleTabOperation(() => strip.close(activeId));
      }),
    },
    {
      group: 'navigate',
      id: 'tab.reopen-closed',
      // Hidden, not a no-op, while the scoped strip has nothing to reopen.
      isAvailable: () => getStrip()?.hasClosedTabs() === true,
      keywords: ['tab', 'restore', 'undo close'],
      label: 'Reopen Closed Tab',
      run: withStrip((strip) => strip.reopenClosed()),
    },
    {
      group: 'navigate',
      id: 'tab.next',
      isAvailable,
      keywords: ['tab', 'switch'],
      label: 'Next Tab',
      run: cycle('next'),
    },
    {
      group: 'navigate',
      id: 'tab.previous',
      isAvailable,
      keywords: ['tab', 'switch'],
      label: 'Previous Tab',
      run: cycle('previous'),
    },
    {
      group: 'navigate',
      id: 'tab.go-to',
      isAvailable,
      keywords: ['tab', 'switch', 'jump'],
      label: 'Go to Tab…',
      page: () => ({
        commands: (getStrip()?.getTabs() ?? []).map(
          (tab): RunCommand => ({
            // The unique tab id is the palette item's value, never the label:
            // two open index.ts files must not select each other.
            id: `tab.go-to:${tab.id}`,
            // The palette shows the first keyword as the item's hint.
            ...(tab.detail ? { keywords: [tab.detail] } : {}),
            label: tab.label,
            run: withStrip((strip) => settleTabOperation(() => strip.activate(tab.id))),
          })
        ),
        heading: 'Tabs',
        placeholder: 'Go to tab…',
      }),
    },
  ];
}

const NO_STRIP: ActionOutcome = { error: 'No tab strip is in scope', ok: false };
