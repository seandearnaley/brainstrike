/** Return the executing CommonJS main bundle path without inferring a fallback. */
export function getMainModulePath(): string {
  if (typeof module.filename !== 'string' || module.filename.length === 0) {
    throw new Error('Desktop main module path is unavailable');
  }
  return module.filename;
}
