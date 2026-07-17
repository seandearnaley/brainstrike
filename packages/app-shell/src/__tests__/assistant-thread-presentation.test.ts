import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_THREAD_COLOR_PRESENTATION,
  getAssistantThreadColorPresentation,
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
});
