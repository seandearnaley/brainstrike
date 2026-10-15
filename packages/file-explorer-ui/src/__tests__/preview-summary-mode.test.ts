// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PREVIEW_SUMMARY_MODES } from '../preview/preview-summary-mode';

describe('preview-summary-mode', () => {
  it('defines the active summary modes in display order', () => {
    expect(PREVIEW_SUMMARY_MODES).toEqual(['compact', 'default', 'expanded']);
  });
});
