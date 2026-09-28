import { adjacentTabId, type TabCycleDirection } from '../tab-strip-actions.js';
import type { ActionOutcome } from '../types.js';
import type { Command, RunCommand } from './types.js';

/**
 * The focus-scoped tab strip the tab commands act on (BST-1842): the strip
 * whose panel held focus when the palette opened. Consumers register these
 * operations; this package holds no tab state.
 */
export interface TabCommandStrip {
  readonly activate: (id: string) => void;
  readonly close: (id: string) => void;
  readonly getActiveId: () => string | null;
  /** Every tab in strip order. */
  readonly getTabs: () => readonly { readonly id: string; readonly label: string }[];
  /** Whether the strip's closed-tab history has an entry to reopen. */
  readonly hasClosedTabs: () => boolean;
  readonly reopenClosed: () => Promise<ActionOutcome>;
}

const OK: ActionOutcome = { ok: true };

/** Activate the tab beside the active one, by position, wrapping (D7). */
export function cycleTab(strip: TabCommandStrip, direction: TabCycleDirection): void {
  const ids = strip.getTabs().map((tab) => tab.id);
  const target = adjacentTabId(ids, strip.getActiveId(), direction);
  if (target !== null) {
    strip.activate(target);
  }
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
    return strip ? run(strip) : Promise.resolve<ActionOutcome>(NO_STRIP);
  };
  const cycle = (direction: TabCycleDirection): RunCommand['run'] =>
    withStrip((strip) => {
      cycleTab(strip, direction);
      return Promise.resolve(OK);
    });

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
        strip.close(activeId);
        return Promise.resolve(OK);
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
            id: `tab.go-to:${tab.id}`,
            label: tab.label,
            run: withStrip((strip) => {
              strip.activate(tab.id);
              return Promise.resolve(OK);
            }),
          })
        ),
        heading: 'Tabs',
        placeholder: 'Go to tab…',
      }),
    },
  ];
}

const NO_STRIP: ActionOutcome = { error: 'No tab strip is in scope', ok: false };
