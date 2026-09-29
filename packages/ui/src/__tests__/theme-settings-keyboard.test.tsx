import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider, type ThemeStorageAdapter } from '../theme-provider';
import { ThemeSettings } from '../theme-settings';
import { THEMES, type ThemeId } from '../themes';

/**
 * The palette picker is a radiogroup, so it owes keyboard users the standard
 * radio-group model: ONE tab stop (the checked card), arrows that move AND
 * select with wrap-around, and Space to select. These run against the real
 * `ThemeProvider` because a mocked `useTheme` freezes `checked` and would hide
 * whether a keypress actually changed the selection.
 */

function createStorage(seed: Record<string, string>): ThemeStorageAdapter {
  const data = new Map(Object.entries(seed));
  return {
    getItem: vi.fn(async (key: string) => data.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
  };
}

async function renderPicker(persisted: ThemeId) {
  const storage = createStorage({ 'ui-theme-palette': persisted });
  const user = userEvent.setup();
  render(
    <ThemeProvider defaultMode="light" storageAdapter={storage}>
      <ThemeSettings />
    </ThemeProvider>
  );
  // The provider renders nothing until storage has resolved.
  await screen.findByRole('radiogroup', { name: 'Theme' });
  return { storage, user };
}

function themeAt(index: number): (typeof THEMES)[number] {
  const theme = THEMES[index];
  if (!theme) {
    throw new Error(`no registered theme at index ${index}`);
  }
  return theme;
}

function cardFor(index: number): HTMLElement {
  return screen.getByRole('radio', { name: themeAt(index).label });
}

function expectOnlyChecked(index: number): void {
  THEMES.forEach((_theme, position) => {
    if (position === index) {
      expect(cardFor(position)).toBeChecked();
    } else {
      expect(cardFor(position)).not.toBeChecked();
    }
  });
}

const LAST = THEMES.length - 1;

describe('ThemeSettings palette keyboard model', () => {
  it('is a single tab stop that lands on the checked card, not the first', async () => {
    expect(THEMES.length).toBeGreaterThan(2);
    const { user } = await renderPicker(themeAt(2).id);
    screen.getByRole('button', { name: 'System' }).focus();

    await user.tab();
    expect(cardFor(2)).toHaveFocus();

    await user.tab();
    expect(screen.getAllByRole('radio')).not.toContain(document.activeElement);
  });

  it('ArrowRight and ArrowDown move focus to the next card and select it', async () => {
    const { user } = await renderPicker(themeAt(0).id);
    cardFor(0).focus();

    await user.keyboard('{ArrowRight}');
    expect(cardFor(1)).toHaveFocus();
    expectOnlyChecked(1);

    await user.keyboard('{ArrowDown}');
    expect(cardFor(2)).toHaveFocus();
    expectOnlyChecked(2);
  });

  it('ArrowLeft and ArrowUp move to the previous card and select it', async () => {
    const { user } = await renderPicker(themeAt(2).id);
    cardFor(2).focus();

    await user.keyboard('{ArrowLeft}');
    expect(cardFor(1)).toHaveFocus();
    expectOnlyChecked(1);

    await user.keyboard('{ArrowUp}');
    expect(cardFor(0)).toHaveFocus();
    expectOnlyChecked(0);
  });

  it('wraps from the last card to the first and from the first to the last', async () => {
    const { user } = await renderPicker(themeAt(LAST).id);
    cardFor(LAST).focus();

    await user.keyboard('{ArrowRight}');
    expect(cardFor(0)).toHaveFocus();
    expectOnlyChecked(0);

    await user.keyboard('{ArrowLeft}');
    expect(cardFor(LAST)).toHaveFocus();
    expectOnlyChecked(LAST);
  });

  it('applies and persists the palette an arrow key selects', async () => {
    const { storage, user } = await renderPicker(themeAt(0).id);
    cardFor(0).focus();

    await user.keyboard('{ArrowRight}');

    const next = themeAt(1).id;
    expect(document.documentElement.dataset['theme']).toBe(next);
    expect(storage.setItem).toHaveBeenCalledWith('ui-theme-palette', next);
  });

  it('Space selects a focused card that is not checked', async () => {
    const { user } = await renderPicker(themeAt(0).id);
    cardFor(1).focus();

    await user.keyboard(' ');

    expectOnlyChecked(1);
  });
});
