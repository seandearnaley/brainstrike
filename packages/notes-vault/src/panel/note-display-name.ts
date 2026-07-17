/** Note display name: the file name without its markdown extension. */
export function noteDisplayName(name: string): string {
  return name.replace(/\.(md|markdown|mdown|mkd)$/i, '');
}
