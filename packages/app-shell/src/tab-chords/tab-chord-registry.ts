import type { ActionOutcome } from '@brainstrike/context-actions';
import { useEffect } from 'react';

/** The document strips the keyboard chords and ⌘K tab commands can drive (BST-1842). */
export type TabChordStripId = 'assistant-threads' | 'browser' | 'workspace';

export interface TabChordTab {
  readonly id: string;
  readonly label: string;
}

/**
 * One strip's operations, read live at keystroke time. Strips stay
 * presentational (`@brainstrike/ui` holds no domain state), so each consumer
 * adapter registers these from its own store.
 */
export interface TabChordStrip {
  readonly activate: (id: string) => void;
  readonly close: (id: string) => void;
  readonly getActiveId: () => string | null;
  /**
   * Focus inside this element scopes chords to the strip. The workspace
   * returns null: it is the strip for focus in no panel.
   */
  readonly getPanel: () => HTMLElement | null;
  /** Every tab in strip order, pinned group first. */
  readonly getTabs: () => readonly TabChordTab[];
  /** Pops the strip's closed-tab history; a stale or empty history fails visibly. */
  readonly reopenClosed: () => Promise<ActionOutcome>;
}

const strips = new Map<TabChordStripId, TabChordStrip>();

/**
 * Register a mounted strip. Two live registrations of one id are a wiring bug,
 * so the second throws. The returned release removes only this registration.
 */
export function registerTabChordStrip(id: TabChordStripId, strip: TabChordStrip): () => void {
  if (strips.has(id)) {
    throw new Error(`Tab chord strip "${id}" is already registered`);
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

/** Keep `strip` registered while the calling component is mounted. Memoize `strip`. */
export function useTabChordStrip(id: TabChordStripId, strip: TabChordStrip): void {
  useEffect(() => registerTabChordStrip(id, strip), [id, strip]);
}
