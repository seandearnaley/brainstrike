import { describe, expect, it } from 'vitest';
import * as previewLayout from '../preview/preview-footer-layout';

describe('preview-footer-layout', () => {
  it('exports only active summary-mode definitions', () => {
    expect(previewLayout.PREVIEW_FOOTER_MODES).toEqual(['compact', 'default', 'expanded']);
    expect(previewLayout).not.toHaveProperty('PREVIEW_FOOTER_HEIGHTS');
    expect(previewLayout).not.toHaveProperty('clampPreviewFooterHeight');
    expect(previewLayout).not.toHaveProperty('getPreviewFooterModeHeight');
    expect(previewLayout).not.toHaveProperty('inferPreviewFooterMode');
  });
});
