import { describe, expect, it } from 'vitest';
import {
  CANVAS_LINK_PROTOCOL,
  formatCanvasLink,
  isLinkableCanvasId,
  parseCanvasLink,
} from '../canvas-link';

const ID = '019a0b3c-4d5e-7f60-8a1b-2c3d4e5f6071';

describe('canvas links', () => {
  it('formats a canvas id as canvas://<id> and parses it back', () => {
    expect(CANVAS_LINK_PROTOCOL).toBe('canvas:');
    const url = formatCanvasLink(ID);
    expect(url).toBe(`canvas://${ID}`);
    expect(parseCanvasLink(url)).toEqual({ canvasId: ID, kind: 'canvas' });
  });

  it('is not a canvas link for every other protocol or a relative href', () => {
    expect(parseCanvasLink('https://example.com/canvas://x')).toEqual({ kind: 'not-canvas' });
    expect(parseCanvasLink('packages/foo.ts')).toEqual({ kind: 'not-canvas' });
    expect(parseCanvasLink('')).toEqual({ kind: 'not-canvas' });
  });

  it('reports a canvas link with no usable id as malformed, never as not-canvas', () => {
    // Falling through to the OS browser would toast "Blocked protocol: canvas:"
    // — true but useless. Mutation: returning not-canvas here fails this row.
    for (const url of ['canvas://', 'canvas:', 'canvas://a/b', 'canvas://a b', 'CANVAS://x/']) {
      expect(parseCanvasLink(url)).toEqual({
        error: 'Canvas link has no usable canvas id',
        kind: 'malformed',
      });
    }
  });

  it('refuses to format an id that could not be parsed back', () => {
    expect(isLinkableCanvasId(ID)).toBe(true);
    expect(isLinkableCanvasId('a/b')).toBe(false);
    expect(isLinkableCanvasId('')).toBe(false);
    expect(() => formatCanvasLink('a/b')).toThrow(/cannot be linked/);
  });
});
