import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { type SavedAppearance, ThemeProvider } from '../theme-provider';
import { ThemeSettings } from '../theme-settings';
import { THEMES, type ThemeId } from '../themes';

/**
 * The palette picker is a radiogroup, so it owes keyboard users the standard
 * radio-group model: ONE tab stop (the checked card), arrows that move AND
 * select with wrap-around, and Space to select. These run against the real
 * `ThemeProvider` because a mocked `useTheme` freezes `checked` and would hide
 * whether a keypress actually changed the selection.
 */

/** The app's side: it owns the saved choices and records what the provider reports. */
async function renderPicker(persisted: ThemeId) {
  const reported: SavedAppearance[] = [];
  function App() {
    const [appearance, setAppearance] = useState<SavedAppearance>({ theme: persisted });
    return (
      <ThemeProvider
        appearance={appearance}
        defaultMode="light"
        onAppearanceChange={(choice) => {
          reported.push(choice);
          setAppearance((previous) => ({ ...previous, ...choice }));
        }}
      >
        <ThemeSettings />
      </ThemeProvider>
    );
  }
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('radiogroup', { name: 'Theme' });
  return { reported, user };
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
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).not.toContainElement(
      document.activeElement as HTMLElement | null
    );
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

  it('applies the palette an arrow key selects and reports it for saving', async () => {
    const { reported, user } = await renderPicker(themeAt(0).id);
    cardFor(0).focus();

    await user.keyboard('{ArrowRight}');

    const next = themeAt(1).id;
    expect(document.documentElement.dataset['theme']).toBe(next);
    expect(reported).toEqual([{ theme: next }]);
  });

  it('Space selects a focused card that is not checked', async () => {
    const { user } = await renderPicker(themeAt(0).id);
    cardFor(1).focus();

    await user.keyboard(' ');

    expectOnlyChecked(1);
  });
});
