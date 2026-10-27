import type { RenderResult } from 'pele';

/** `theme` paints the diagram's own background; `transparent` leaves it out. */
export type DiagramBackground = 'theme' | 'transparent';

export const DIAGRAM_PNG_SCALES = [1, 2, 3, 4] as const;
export type DiagramPngScale = (typeof DIAGRAM_PNG_SCALES)[number];

/** Chromium's per-side canvas limit; a larger PNG cannot be drawn. */
export const MAX_CANVAS_SIDE = 16_384;

const SVG_NS = 'http://www.w3.org/2000/svg';
const PELE_VARIABLE = /var\((--pele-[a-z0-9-]+)/g;

export interface StandaloneDiagram {
  readonly height: number;
  readonly svg: string;
  readonly width: number;
}

/** Pixel size of the PNG a scale produces. */
export function pngSize(
  diagram: Pick<RenderResult, 'height' | 'width'>,
  scale: DiagramPngScale
): { readonly height: number; readonly width: number } {
  return { height: Math.round(diagram.height * scale), width: Math.round(diagram.width * scale) };
}

export function fitsCanvas(
  diagram: Pick<RenderResult, 'height' | 'width'>,
  scale: DiagramPngScale
): boolean {
  const { height, width } = pngSize(diagram, scale);
  return width <= MAX_CANVAS_SIDE && height <= MAX_CANVAS_SIDE;
}

function familyNames(stack: string): string[] {
  return stack
    .split(',')
    .map((name) =>
      name
        .trim()
        .replace(/^["']|["']$/g, '')
        .toLowerCase()
    )
    .filter((name) => name.length > 0);
}

function* fontFaceRules(rules: CSSRuleList): Generator<CSSFontFaceRule> {
  for (const rule of rules) {
    if (rule instanceof CSSFontFaceRule) {
      yield rule;
    } else if (rule instanceof CSSImportRule) {
      if (rule.styleSheet) {
        yield* fontFaceRules(rule.styleSheet.cssRules);
      }
    } else if ('cssRules' in rule && rule.cssRules instanceof CSSRuleList) {
      yield* fontFaceRules(rule.cssRules);
    }
  }
}

async function dataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load the diagram font (${response.status} ${url})`);
  }
  const blob = await response.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsDataURL(blob);
  });
}

/** The page's `@font-face` rules for these families, with each font file
 * inlined: an SVG drawn as an image cannot load the app's web fonts, and the
 * labels were sized for them. */
async function embeddedFontFaces(doc: Document, families: ReadonlySet<string>): Promise<string> {
  const faces: Promise<string>[] = [];
  for (const sheet of doc.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // A cross-origin sheet hides its rules; the app's fonts are not in one.
      continue;
    }
    for (const rule of fontFaceRules(rules)) {
      const family = familyNames(rule.style.getPropertyValue('font-family'))[0];
      if (family === undefined || !families.has(family)) {
        continue;
      }
      const base = rule.parentStyleSheet?.href ?? doc.baseURI;
      const urls = [...rule.cssText.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)];
      faces.push(
        Promise.all(
          urls.map(async (match) => [match[0], await dataUrl(new URL(match[2] ?? '', base).href)])
        ).then((inlined) =>
          inlined.reduce(
            (css, [original, data]) => css.replace(original ?? '', `url("${data}")`),
            rule.cssText
          )
        )
      );
    }
  }
  return (await Promise.all(faces)).join('\n');
}

/**
 * A self-contained copy of a drawn diagram. Pele colours diagrams through
 * `--pele-*` variables that the page defines, so each one the SVG reads is
 * resolved from `live` (the drawn `<svg>`) and written onto the copy, with the
 * label fonts embedded. The copy keeps the layout the reader is looking at.
 */
export async function standaloneDiagram(
  live: SVGSVGElement,
  rendered: Pick<RenderResult, 'height' | 'svg' | 'width'>,
  background: DiagramBackground
): Promise<StandaloneDiagram> {
  const doc = live.ownerDocument;
  const parsed = new DOMParser().parseFromString(rendered.svg, 'image/svg+xml');
  const root = parsed.documentElement;
  if (!(root instanceof SVGSVGElement)) {
    throw new Error('The diagram could not be copied');
  }
  const view = doc.defaultView ?? window;
  const computed = view.getComputedStyle(live);
  for (const [, name] of rendered.svg.matchAll(PELE_VARIABLE)) {
    const value = name === undefined ? '' : computed.getPropertyValue(name).trim();
    if (name !== undefined && value) {
      root.style.setProperty(name, value);
    }
  }
  root.style.removeProperty('max-width');
  root.style.removeProperty('height');
  root.setAttribute('width', String(rendered.width));
  root.setAttribute('height', String(rendered.height));

  const families = new Set([
    ...familyNames(computed.fontFamily),
    ...familyNames(computed.getPropertyValue('--pele-font-mono')),
  ]);
  if (background === 'theme') {
    // First child, so everything else paints over it.
    const fill = parsed.createElementNS(SVG_NS, 'rect');
    fill.setAttribute('width', '100%');
    fill.setAttribute('height', '100%');
    fill.setAttribute('fill', 'var(--_bg)');
    root.prepend(fill);
  }
  const fonts = await embeddedFontFaces(doc, families);
  if (fonts) {
    const style = parsed.createElementNS(SVG_NS, 'style');
    style.textContent = fonts;
    root.prepend(style);
  }
  return {
    height: rendered.height,
    svg: new XMLSerializer().serializeToString(root),
    width: rendered.width,
  };
}

/** Draws a standalone diagram to a PNG at `scale` device pixels per CSS pixel. */
export async function diagramPng(
  diagram: StandaloneDiagram,
  scale: DiagramPngScale
): Promise<Blob> {
  if (!fitsCanvas(diagram, scale)) {
    throw new Error(`The diagram is too large to export at ${scale}×`);
  }
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(diagram.svg)}`;
  await image.decode();
  const { height, width } = pngSize(diagram, scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Could not draw the diagram image');
  }
  context.drawImage(image, 0, 0, width, height);
  return await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Could not encode the diagram image'));
      }
    }, 'image/png');
  });
}
