import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { composite, contrastRatio, hslToRgb, oklchToRgb, relativeLuminance } from '../lib/color-contrast.mjs';

function close(actual, expected, tolerance = 0.000_01) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} must be within ${tolerance} of ${expected}`);
}

describe('WCAG sRGB contrast arithmetic', () => {
  it('matches black, white and primary-color reference luminances', () => {
    assert.equal(relativeLuminance([0, 0, 0]), 0);
    assert.equal(relativeLuminance([1, 1, 1]), 1);
    assert.equal(relativeLuminance([1, 0, 0]), 0.2126);
    assert.equal(relativeLuminance([0, 1, 0]), 0.7152);
    assert.equal(relativeLuminance([0, 0, 1]), 0.0722);
    assert.equal(contrastRatio([0, 0, 0], [1, 1, 1]), 21);
    assert.equal(contrastRatio([1, 1, 1], [0, 0, 0]), 21);
    assert.equal(contrastRatio([0.3, 0.5, 0.7], [0.3, 0.5, 0.7]), 1);
    close(contrastRatio([1, 0, 0], [1, 1, 1]), 3.998_476_77);
  });

  it('converts HSL, including wrapped hues and achromatic colors', () => {
    assert.deepEqual(hslToRgb([0, 100, 50]), [1, 0, 0]);
    assert.deepEqual(hslToRgb([360, 100, 50]), [1, 0, 0]);
    assert.deepEqual(hslToRgb([-120, 100, 50]), [0, 0, 1]);
    assert.deepEqual(hslToRgb([125, 0, 25]), [0.25, 0.25, 0.25]);
    assert.deepEqual(hslToRgb([120, 100, 50]), [0, 1, 0]);
  });

  it('converts independently known OKLCH red and neutral samples', () => {
    const red = oklchToRgb([0.627_955_36, 0.257_683_31, 29.233_885]);
    red.forEach((channel, index) => close(channel, [1, 0, 0][index]));
    oklchToRgb([0.5, 0, 0]).forEach((channel) => close(channel, 0.388_572_86));
    oklchToRgb([1, 0, 0]).forEach((channel) => close(channel, 1));
    assert.deepEqual(oklchToRgb([0, 0, 0]), [0, 0, 0]);
  });

  it('clips out-of-sRGB colors consistently before compositing and luminance', () => {
    assert.ok(oklchToRgb([0.7, 0.5, 120]).every((channel) => channel >= 0 && channel <= 1));
    assert.equal(relativeLuminance([-0.1, 1.1, 0]), 0.7152);
    assert.deepEqual(composite([-0.1, 1.1, 0], [1, 1, 1], 0.5), [0.5, 1, 0.5]);
  });

  it('composites alpha in sRGB before measuring the painted foreground', () => {
    assert.deepEqual(composite([0, 0, 0], [1, 1, 1], 0.5), [0.5, 0.5, 0.5]);
    assert.deepEqual(composite([1, 0, 0], [0, 0, 1], 0), [0, 0, 1]);
    assert.deepEqual(composite([1, 0, 0], [0, 0, 1], 1), [1, 0, 0]);
    close(contrastRatio(composite([0, 0, 0], [1, 1, 1], 0.5), [1, 1, 1]), 3.976_653_02);
  });

  it('rejects malformed numbers rather than silently reporting a pass', () => {
    assert.throws(() => relativeLuminance([Number.NaN, 0, 0]), /finite/);
    assert.throws(() => hslToRgb([0, 0]), /three/);
    assert.throws(() => oklchToRgb([0.5, Number.POSITIVE_INFINITY, 0]), /finite/);
    assert.throws(() => composite([0, 0, 0], [1, 1, 1], 1.1), /opacity/);
  });
});
