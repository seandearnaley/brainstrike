/** A text's synthetic vector, before the embedding worker normalizes it: three dimensions. */
export function syntheticVector(text: string): Float32Array {
  let sum = 0;
  for (const character of text) {
    sum += character.codePointAt(0) ?? 0;
  }
  return Float32Array.of(text.length, (sum % 97) + 1, 1);
}

/** The vector the stack returns for `text`: the worker L2-normalizes each one. */
export function expectedVector(text: string): number[] {
  const vector = Array.from(syntheticVector(text));
  const norm = Math.hypot(...vector);
  return vector.map((value) => Math.fround(value / norm));
}
