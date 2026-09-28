import type { TabCommandStrip } from '@brainstrike/context-actions/commands';
import { createLogger } from '@brainstrike/logging';
import { useEffect } from 'react';

const logger = createLogger('TabChordRegistry');

/** The document strips the keyboard chords and ⌘K tab commands can drive (BST-1842). */
export type TabChordStripId = 'assistant-threads' | 'browser' | 'workspace';

/**
 * One strip's operations, read live at keystroke time — the ⌘K tab commands'
 * strip plus the panel that scopes focus to it. Strips stay presentational
 * (`@brainstrike/ui` holds no domain state), so each consumer adapter
 * registers these from its own store.
 */
export interface TabChordStrip extends TabCommandStrip {
  /**
   * Focus inside this element scopes chords to the strip. The workspace
   * returns null: it is the strip for focus in no panel.
   */
  readonly getPanel: () => HTMLElement | null;
}

const strips = new Map<TabChordStripId, TabChordStrip>();

/**
 * Register a mounted strip. Two live registrations of one id are a wiring bug:
 * the second is logged at error level (visible in diagnostics) and ignored, so
 * the first keeps routing and the UI never goes down over it. The returned
 * release removes only this registration.
 */
export function registerTabChordStrip(id: TabChordStripId, strip: TabChordStrip): () => void {
  if (strips.has(id)) {
    logger.error(`Tab chord strip "${id}" is already registered; keeping the first`, { id });
    return () => undefined;
  }
  strips.set(id, strip);
  return () => {
    if (strips.get(id) === strip) {
      strips.delete(id);
    }
  };
}

export function getTabChordStrip(id: TabChordStripId): TabChordStrip | undefined {
  return strips.get(id);
}

/** The strip whose panel contains `element`; the workspace strip when none does. */
export function resolveTabChordScope(element: Element | null): TabChordStripId {
  if (element) {
    for (const [id, strip] of strips) {
      if (strip.getPanel()?.contains(element)) {
        return id;
      }
    }
  }
  return 'workspace';
}

/**
 * Keep `strip` registered while the calling component is mounted. Memoize
 * `strip`; `null` registers nothing (a surface whose capability is absent).
 */
export function useTabChordStrip(id: TabChordStripId, strip: TabChordStrip | null): void {
  useEffect(() => (strip ? registerTabChordStrip(id, strip) : undefined), [id, strip]);
}
