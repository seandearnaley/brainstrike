/**
 * A text's synthetic vector, before the embedding worker normalizes it: a
 * pure function of the text, at `dimensions` dimensions (three by default).
 */
export function syntheticVector(text: string, dimensions = 3): Float32Array {
  let sum = 0;
  for (const character of text) {
    sum += character.codePointAt(0) ?? 0;
  }
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    vector[index] =
      index === 0 ? text.length : index === 1 ? (sum % 97) + 1 : ((sum + index * 31) % 89) + 1;
  }
  return vector;
}

/** The vector the stack returns for `text`: the worker L2-normalizes each one. */
export function expectedVector(text: string, dimensions = 3): number[] {
  const vector = Array.from(syntheticVector(text, dimensions));
  const norm = Math.hypot(...vector);
  return vector.map((value) => Math.fround(value / norm));
}
