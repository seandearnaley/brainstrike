import { describe, expect, it } from 'vitest';
import { normalizePointerPosition, shouldTrackPointer } from './webgpu-interaction';

describe('WebGPU pointer interaction contract', () => {
  it('allows only mouse pointers on fine-hover devices', () => {
    expect(shouldTrackPointer({ fineHover: true, pointerType: 'mouse' })).toBe(true);
    expect(shouldTrackPointer({ fineHover: false, pointerType: 'mouse' })).toBe(false);
    expect(shouldTrackPointer({ fineHover: true, pointerType: 'pen' })).toBe(false);
    expect(shouldTrackPointer({ fineHover: true, pointerType: 'touch' })).toBe(false);
  });

  it('normalizes and clamps pointer coordinates to the canvas', () => {
    const bounds = { height: 200, left: 100, top: 50, width: 400 };

    expect(normalizePointerPosition({ clientX: 300, clientY: 150 }, bounds)).toEqual({
      x: 0,
      y: 0,
    });
    expect(normalizePointerPosition({ clientX: 900, clientY: -100 }, bounds)).toEqual({
      x: 1,
      y: 1,
    });
  });

  it('rejects non-renderable canvas bounds instead of emitting invalid uniforms', () => {
    expect(() =>
      normalizePointerPosition(
        { clientX: 0, clientY: 0 },
        { height: 0, left: 0, top: 0, width: 100 }
      )
    ).toThrow('positive finite dimensions');
    expect(() =>
      normalizePointerPosition(
        { clientX: 0, clientY: 0 },
        { height: 100, left: Number.NaN, top: 0, width: 100 }
      )
    ).toThrow('finite origin');
  });
});
