/**
 * Turns a title into a URL slug. The slug holds only lowercase ASCII letters
 * and digits; each run of any other characters becomes one hyphen; it never
 * starts or ends with a hyphen. A title with no letters or digits has the
 * empty slug.
 *
 * slugify('  Hello, World! 2026 ') === 'hello-world-2026'
 */
export function slugify(title: string): string {
  throw new Error(`slugify is not implemented: ${title}`);
}
