export type TabChordAction = 'close' | 'next' | 'previous' | 'reopen';

export interface TabChordEnvironment {
  /**
   * The host app, not a browser, owns the window, so the browser-reserved
   * chords (⌘W, ⌘⇧T, Ctrl+Tab) are ours to claim. False on web.
   */
  readonly claimWindowChords: boolean;
  readonly isMac: boolean;
}

interface Modifiers {
  readonly alt?: true;
  readonly ctrl?: true;
  readonly meta?: true;
  readonly shift?: true;
}

/** Exactly these modifiers held — an extra one means a different chord. */
function held(event: KeyboardEvent, modifiers: Modifiers): boolean {
  return (
    event.altKey === (modifiers.alt === true) &&
    event.ctrlKey === (modifiers.ctrl === true) &&
    event.metaKey === (modifiers.meta === true) &&
    event.shiftKey === (modifiers.shift === true)
  );
}

function matchCycleChord(event: KeyboardEvent, isMac: boolean): TabChordAction | null {
  if (held(event, { ctrl: true })) {
    if (event.key === 'PageDown') {
      return 'next';
    }
    if (event.key === 'PageUp') {
      return 'previous';
    }
  }
  // VS Code's nextEditor / previousEditor on macOS.
  if (isMac && held(event, { alt: true, meta: true })) {
    if (event.key === 'ArrowRight') {
      return 'next';
    }
    if (event.key === 'ArrowLeft') {
      return 'previous';
    }
  }
  return null;
}

const PHYSICAL_LETTER = /^Key([A-Z])$/;

/**
 * The letter a chord names. `event.key` wins, so a Latin layout matches what
 * its keycap says. Only when `key` is a letter of another script (Russian ц on
 * the W key) does the physical `event.code` stand in. Never for punctuation:
 * Dvorak's KeyW is ",", and ⌘, is macOS Preferences.
 */
function chordLetter(event: KeyboardEvent): string | null {
  if (/^[a-z]$/i.test(event.key)) {
    return event.key.toLowerCase();
  }
  if (/^\p{L}$/u.test(event.key)) {
    return PHYSICAL_LETTER.exec(event.code)?.[1]?.toLowerCase() ?? null;
  }
  return null;
}

function matchWindowChord(event: KeyboardEvent, isMac: boolean): TabChordAction | null {
  const primary: Modifiers = isMac ? { meta: true } : { ctrl: true };
  const key = chordLetter(event);
  if (key === 'w' && held(event, primary)) {
    return 'close';
  }
  if (key === 't' && held(event, { ...primary, shift: true })) {
    return 'reopen';
  }
  // D7: positional, like Chrome. Ctrl on every platform, macOS included.
  if (event.key === 'Tab') {
    if (held(event, { ctrl: true })) {
      return 'next';
    }
    if (held(event, { ctrl: true, shift: true })) {
      return 'previous';
    }
  }
  return null;
}

/** The tab action a keydown asks for (BST-1836 §9), or null when it is not a tab chord. */
export function matchTabChord(
  event: KeyboardEvent,
  { claimWindowChords, isMac }: TabChordEnvironment
): TabChordAction | null {
  return (
    matchCycleChord(event, isMac) ?? (claimWindowChords ? matchWindowChord(event, isMac) : null)
  );
}
