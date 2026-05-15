/** Counts separator occurrences instead of allocating via split(). */
export function getPathDepth(path: string): number {
  let depth = 0;
  let index = path.indexOf('/');
  while (index !== -1) {
    depth++;
    index = path.indexOf('/', index + 1);
  }
  return depth;
}
