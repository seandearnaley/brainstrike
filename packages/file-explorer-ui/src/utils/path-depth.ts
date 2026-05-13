/**
 * Highly optimized function to calculate the depth of a path.
 * Avoids array allocations compared to path.split('/').length - 1
 */
export function getPathDepth(path: string): number {
  let depth = 0;
  let index = path.indexOf('/');
  while (index !== -1) {
    depth++;
    index = path.indexOf('/', index + 1);
  }
  return depth;
}
