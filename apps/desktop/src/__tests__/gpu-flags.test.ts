import { describe, expect, it } from 'vitest';
import {
  DISABLED_CHROMIUM_FEATURES,
  disabledChromiumFeatures,
  FORBIDDEN_GPU_SWITCHES,
} from '../gpu-flags';

describe('GPU flag configuration', () => {
  it('disables MacWebContentsOcclusion and SpareRendererForSitePerProcess', () => {
    expect(DISABLED_CHROMIUM_FEATURES).toContain('MacWebContentsOcclusion');
    expect(DISABLED_CHROMIUM_FEATURES).toContain('SpareRendererForSitePerProcess');
  });

  it('forbids enable-gpu-rasterization and enable-zero-copy', () => {
    expect(FORBIDDEN_GPU_SWITCHES).toContain('enable-gpu-rasterization');
    expect(FORBIDDEN_GPU_SWITCHES).toContain('enable-zero-copy');
  });

  it('disabled features do NOT include any forbidden switches', () => {
    for (const forbidden of FORBIDDEN_GPU_SWITCHES) {
      expect(DISABLED_CHROMIUM_FEATURES).not.toContain(forbidden);
    }
  });

  it("keeps the launch's own disabled features beside the app's", () => {
    expect(disabledChromiumFeatures('CalculateNativeWinOcclusion,MacWebContentsOcclusion')).toBe(
      'CalculateNativeWinOcclusion,MacWebContentsOcclusion,SpareRendererForSitePerProcess'
    );
    expect(disabledChromiumFeatures('')).toBe(DISABLED_CHROMIUM_FEATURES.join(','));
  });
});
