import { fileURLToPath } from 'node:url';

/** The package's own Windows command wrapper, as its standalone host resolves it. */
export const windowsCommandEntry = (): string =>
  fileURLToPath(new URL('../../bin/windows-command-entry.mjs', import.meta.url));
