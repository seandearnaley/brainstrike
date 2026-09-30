/**
 * Dependency-free WCAG 2.x contrast arithmetic on normalized sRGB channels.
 * Conversion matrices follow https://www.w3.org/TR/css-color-4/#color-conversion-code.
 * Gamut policy: channel clipping into sRGB, not perceptual gamut mapping. This
 * is a static sRGB guard, not a substitute for browser checks of wide-gamut paint.
 * Opacity is composited in sRGB before luminance, never applied to the ratio.
 */
const WEIGHTS = [0.2126, 0.7152, 0.0722];
const clamp = (value) => Math.min(1, Math.max(0, value));

function triple(values) {
  if (!Array.isArray(values) || values.length !== 3) {
    throw new TypeError('Color must contain exactly three channels');
  }
  if (!values.every(Number.isFinite)) {
    throw new TypeError('Color channels must be finite numbers');
  }
  return values;
}

export function hslToRgb(values) {
  const [hue, saturationPercent, lightnessPercent] = triple(values);
  const saturation = clamp(saturationPercent / 100);
  const lightness = clamp(lightnessPercent / 100);
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (((hue % 360) + 360) % 360) / 60;
  const secondary = chroma * (1 - Math.abs((sector % 2) - 1));
  const rgb = [
    [chroma, secondary, 0],
    [secondary, chroma, 0],
    [0, chroma, secondary],
    [0, secondary, chroma],
    [secondary, 0, chroma],
    [chroma, 0, secondary],
  ][Math.floor(sector)];
  return rgb.map((channel) => clamp(channel + lightness - chroma / 2));
}

function encodeSrgb(linear) {
  const channel = clamp(linear);
  return channel <= 0.003_130_8 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
}

/** Lightness is 0..1, chroma is absolute OKLCH chroma, hue is in degrees. */
export function oklchToRgb(values) {
  const [lightness, chroma, hue] = triple(values);
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
  const m = (lightness - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
  const s = (lightness - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;
  return [
    4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s,
    -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s,
    -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s,
  ]
    .map(encodeSrgb)
    .map(clamp);
}

export function composite(foreground, background, opacity) {
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new RangeError('Color opacity must be between 0 and 1');
  }
  const backdrop = triple(background).map(clamp);
  return triple(foreground).map(
    (channel, index) => clamp(channel) * opacity + backdrop[index] * (1 - opacity)
  );
}

export function relativeLuminance(rgb) {
  return triple(rgb)
    .map(clamp)
    .map((channel) => (channel <= 0.040_45 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * WEIGHTS[index], 0);
}

export function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}
