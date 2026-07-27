import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_THREAD_COLOR_PRESENTATION,
  getAssistantThreadColorPresentation,
  getAssistantThreadColorSurface,
  THREAD_CONTROL_HEIGHT_CLASS_NAME,
  THREAD_CONTROL_HEIGHT_PX,
  THREAD_CONTROL_MARK_CLASS_NAME,
  THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME,
  THREAD_CONTROL_ROW_PITCH_PX,
  THREAD_CONTROL_TITLE_CLASS_NAME,
  UNASSIGNED_ASSISTANT_THREAD_COLOR_PRESENTATION,
} from '../assistant-thread-presentation';

describe('assistant thread presentation', () => {
  it('resolves every durable metadata color to explicit light and dark presentation classes', () => {
    expect(Object.keys(ASSISTANT_THREAD_COLOR_PRESENTATION).sort()).toEqual([
      'amber',
      'blue',
      'emerald',
      'rose',
      'slate',
      'violet',
    ]);
    expect(getAssistantThreadColorPresentation('rose')).toMatchObject({
      accentClassName: 'bg-rose-500',
      label: 'Rose',
    });
    expect(getAssistantThreadColorPresentation('rose')?.iconClassName).toContain('dark:');
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

  it('keeps unassigned thread color neutral instead of guessing blue', () => {
    expect(getAssistantThreadColorPresentation(undefined)).toBeNull();
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
    expect(THREAD_CONTROL_MARK_CLASS_NAME).toContain('ring-inset');
    expect(THREAD_CONTROL_MARK_CLASS_NAME).not.toContain('border');
  });
});
