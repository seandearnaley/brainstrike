import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME,
  ASSISTANT_ACTION_BAR_CLASSNAME,
} from '../assistant-ui-panel';

describe('AssistantActionBar styling', () => {
  it('drops the floating box (no border/shadow/background/rounded)', () => {
    for (const token of ['border', 'shadow', 'bg-background', 'rounded-md']) {
      expect(ASSISTANT_ACTION_BAR_CLASSNAME).not.toContain(token);
    }
  });
  it('keeps floating on hover', () => {
    expect(ASSISTANT_ACTION_BAR_CLASSNAME).toContain('data-[floating]:absolute');
  });
  it('uses smaller buttons', () => {
    expect(ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME).toContain('size-5');
  });
});
