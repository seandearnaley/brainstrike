export function sliceCodePoints(value: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) {
    return '';
  }
  let result = '';
  let codePoints = 0;
  for (const codePoint of value) {
    if (codePoints >= maxCodePoints) {
      break;
    }
    result += codePoint;
    codePoints += 1;
  }
  return result;
}
