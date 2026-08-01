export interface PointerInput {
  readonly clientX: number;
  readonly clientY: number;
}

export interface PointerBounds {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

export interface NormalizedPointerPosition {
  readonly x: number;
  readonly y: number;
}

interface PointerCapability {
  readonly fineHover: boolean;
  readonly pointerType: string;
}

function clampSignedUnit(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

export function shouldTrackPointer({ fineHover, pointerType }: PointerCapability): boolean {
  return fineHover && pointerType === 'mouse';
}

export function normalizePointerPosition(
  pointer: PointerInput,
  bounds: PointerBounds
): NormalizedPointerPosition {
  if (
    !(
      Number.isFinite(bounds.width) &&
      bounds.width > 0 &&
      Number.isFinite(bounds.height) &&
      bounds.height > 0
    )
  ) {
    throw new Error('Pointer bounds require positive finite dimensions.');
  }
  if (!(Number.isFinite(bounds.left) && Number.isFinite(bounds.top))) {
    throw new Error('Pointer bounds require a finite origin.');
  }
  if (!(Number.isFinite(pointer.clientX) && Number.isFinite(pointer.clientY))) {
    throw new Error('Pointer coordinates must be finite numbers.');
  }

  return {
    x: clampSignedUnit(((pointer.clientX - bounds.left) / bounds.width) * 2 - 1),
    y: clampSignedUnit(1 - ((pointer.clientY - bounds.top) / bounds.height) * 2),
  };
}
