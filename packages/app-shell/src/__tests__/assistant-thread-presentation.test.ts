import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_THREAD_COLOR_PALETTES,
  ASSISTANT_THREAD_COLOR_PRESENTATION,
  ASSISTANT_THREAD_ICON_PRESENTATION,
  getAssistantThreadColorSurface,
  getAssistantThreadIconPresentation,
  THREAD_CONTROL_HEIGHT_CLASS_NAME,
  THREAD_CONTROL_HEIGHT_PX,
  THREAD_CONTROL_MARK_CLASS_NAME,
  THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME,
  THREAD_CONTROL_ROW_PITCH_PX,
  THREAD_CONTROL_TITLE_CLASS_NAME,
  UNASSIGNED_ASSISTANT_THREAD_COLOR_PRESENTATION,
} from '../assistant-thread-presentation';

describe('assistant thread presentation', () => {
  it('publishes one exhaustive icon registry with a documented message default', () => {
    expect(Object.keys(ASSISTANT_THREAD_ICON_PRESENTATION).sort()).toEqual([
      'bug',
      'code',
      'message',
      'plan',
      'research',
      'rocket',
    ]);
    expect(ASSISTANT_THREAD_ICON_PRESENTATION.research.label).toBe('Research');
    expect(
      Object.entries(ASSISTANT_THREAD_ICON_PRESENTATION).map(([iconId, presentation]) => [
        iconId,
        presentation.iconId,
      ])
    ).toEqual([
      ['bug', 'bug'],
      ['code', 'code'],
      ['message', 'message'],
      ['plan', 'plan'],
      ['research', 'research'],
      ['rocket', 'rocket'],
    ]);
    expect(getAssistantThreadIconPresentation(undefined)).toBe(
      ASSISTANT_THREAD_ICON_PRESENTATION.message
    );
    expect(getAssistantThreadIconPresentation('bug')).toBe(ASSISTANT_THREAD_ICON_PRESENTATION.bug);
  });

  it('resolves every durable metadata color to explicit light and dark presentation classes', () => {
    expect(ASSISTANT_THREAD_COLOR_PALETTES.map(({ label }) => label)).toEqual([
      'Studio',
      'Voltage',
      'Afterglow',
    ]);
    expect(ASSISTANT_THREAD_COLOR_PALETTES.flatMap(({ colors }) => colors).sort()).toEqual(
      Object.keys(ASSISTANT_THREAD_COLOR_PRESENTATION).sort()
    );
    expect(Object.keys(ASSISTANT_THREAD_COLOR_PRESENTATION)).toHaveLength(18);
    expect(ASSISTANT_THREAD_COLOR_PRESENTATION.rose).toMatchObject({
      accentClassName: 'bg-rose-500',
      label: 'Rose',
    });
    expect(ASSISTANT_THREAD_COLOR_PRESENTATION.rose.markClassName).toContain('dark:');
  });

  it('styles rows with tinted fills and inset rings instead of borders and stripes', () => {
    for (const presentation of Object.values(ASSISTANT_THREAD_COLOR_PRESENTATION)) {
      expect(presentation.idleClassName).not.toContain('border');
      expect(presentation.idleClassName).toContain('bg-');
      expect(presentation.selectedClassName).not.toContain('border');
      expect(presentation.selectedClassName).toContain('ring-inset');
      expect(presentation.groupSurfaceClassName).not.toContain('border');
    }
  });

  it('resolves an unassigned thread to a neutral surface so every control can be tinted', () => {
    expect(getAssistantThreadColorSurface(undefined)).toBe(
      UNASSIGNED_ASSISTANT_THREAD_COLOR_PRESENTATION
    );
    expect(getAssistantThreadColorSurface('violet')).toBe(
      ASSISTANT_THREAD_COLOR_PRESENTATION.violet
    );
    expect(UNASSIGNED_ASSISTANT_THREAD_COLOR_PRESENTATION.idleClassName).toContain('bg-muted');
    expect(UNASSIGNED_ASSISTANT_THREAD_COLOR_PRESENTATION.selectedClassName).toContain(
      'ring-inset'
    );
    // Neutral means theme tokens only — an unassigned thread must never borrow a
    // palette hue and read as though the user had picked one.
    const paletteHue = new RegExp(
      `-(?:${Object.keys(ASSISTANT_THREAD_COLOR_PRESENTATION).join('|')}|sky)-\\d`
    );
    for (const className of Object.values(UNASSIGNED_ASSISTANT_THREAD_COLOR_PRESENTATION)) {
      expect(className).not.toMatch(paletteHue);
    }
  });

  it('publishes one density contract for every surface that renders a thread', () => {
    expect(THREAD_CONTROL_HEIGHT_PX).toBe(28);
    expect(THREAD_CONTROL_HEIGHT_CLASS_NAME).toBe('h-7');
    expect(THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME).toBe('min-h-7');
    // 28px control + the 2px vertical margin on each side of a panel row.
    expect(THREAD_CONTROL_ROW_PITCH_PX).toBe(THREAD_CONTROL_HEIGHT_PX + 4);
    expect(THREAD_CONTROL_TITLE_CLASS_NAME).toContain('text-xs');
    expect(THREAD_CONTROL_TITLE_CLASS_NAME).not.toContain('text-[13px]');
    expect(THREAD_CONTROL_MARK_CLASS_NAME).toContain('size-5');
    // The mark sits on a tinted surface, so it needs its own outline to read.
    expect(THREAD_CONTROL_MARK_CLASS_NAME).toContain('border');
  });

  it('keeps the identity mark legible against the tinted surface it sits on', () => {
    const fills = (classNames: string): string[] =>
      classNames.split(' ').filter((token) => token.startsWith('bg-'));

    for (const presentation of [
      ...Object.values(ASSISTANT_THREAD_COLOR_PRESENTATION),
      UNASSIGNED_ASSISTANT_THREAD_COLOR_PRESENTATION,
    ]) {
      const surfaceFills = [
        ...fills(presentation.selectedClassName),
        ...fills(presentation.idleClassName),
      ];
      // Both the tab and the panel row now paint themselves with the surface
      // fill, so a mark that reuses it disappears into its own control.
      for (const markFill of fills(presentation.markClassName)) {
        expect(surfaceFills).not.toContain(markFill);
      }
      expect(presentation.markClassName).toContain('border-');
    }
  });
});
